import type { Clock } from '@rp/shared'
import {
  type ClockMode,
  type EventPayloadFor,
  type SessionEvent,
  type SessionEventName,
  type SessionLanguage,
} from './events.js'
import type { TextModelChunk, TextModelMessage, TextModelPort } from './model-port.js'

/**
 * Single-agent text session driver (M1 D1).
 *
 * This is the product seam: a transport-agnostic library that turns commands
 * (`send`, `interrupt`, `close`) into §2.1 events. The CLI is one composition
 * root over it; the eval harness and the future API are others.
 *
 * M1 has one speaker, so there is no arbitration. The driver still mints one
 * implicit grant per turn and emits `turn.granted`: `persona.response.*`
 * requires a grant under the §3.2 wire contract, and emitting output without
 * one would make every transcript fail the §3.2 guard. Grant issuance here is
 * bookkeeping, not a second speaker being chosen.
 *
 * The driver never reads the wall clock. It reads the injected `Clock` for grant
 * expiry only; the consumer stamps transcript timestamps. It has no module-level
 * randomness and makes no random choice in M1.
 */

export class SessionDriverError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionDriverError'
  }
}

export class SessionClosedError extends SessionDriverError {
  constructor() {
    super('the session is closed; send() is no longer accepted')
    this.name = 'SessionClosedError'
  }
}

export interface CreateTextSessionDriverOptions {
  /** Minted once per process; never reused across restarts (M1 D3). */
  readonly sessionId: string
  readonly lang: SessionLanguage
  /** Present only when the session replays a registered task. */
  readonly taskId?: string
  /** `wall` for a live session, `simulated` in tests and replay. */
  readonly clockMode?: ClockMode
  readonly clock: Clock
  readonly model: TextModelPort
  /** Defaults to `persona-1`; M1 has exactly one speaker. */
  readonly personaId?: string
  /** Implicit grant lifetime. Defaults to 60 seconds of injected clock time. */
  readonly grantTtlMs?: number
}

export interface SessionDriver {
  readonly sessionId: string
  /** One consumer. Events are yielded as they are produced, not after the turn. */
  readonly events: AsyncIterable<SessionEvent>
  /** Commit one user utterance and stream the reply. Resolves when the turn ends. */
  send(text: string): Promise<void>
  /** Abort the in-flight reply. No-op when nothing is streaming. */
  interrupt(): Promise<void>
  /** Abort anything in flight, emit `session.completed`, and end the event stream. */
  close(): Promise<void>
}

const DEFAULT_GRANT_TTL_MS = 60_000
const DEFAULT_PERSONA_ID = 'persona-1'

/**
 * Async event queue: `emit` never blocks, and a consumer sees each event as soon
 * as it is appended. Closing ends the iterator; a stored error rejects it.
 */
export class AsyncEventQueue<T> implements AsyncIterableIterator<T> {
  readonly #items: T[] = []
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = []
  #closed = false
  #failure: unknown

  push(item: T): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      waiter({ value: item, done: false })
      return
    }
    this.#items.push(item)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true })
    }
  }

  fail(error: unknown): void {
    if (this.#closed) return
    this.#failure = error
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true })
    }
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.#items.shift()
    if (item !== undefined) return Promise.resolve({ value: item, done: false })
    if (this.#closed) {
      if (this.#failure !== undefined) return Promise.reject(this.#failure)
      return Promise.resolve({ value: undefined, done: true })
    }
    return new Promise((resolve) => {
      this.#waiters.push(resolve)
    })
  }

  return(): Promise<IteratorResult<T>> {
    this.close()
    return Promise.resolve({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this
  }
}

interface ActiveTurn {
  readonly turnId: string
  readonly grantId: string
  readonly expiresAtMs: number
  readonly controller: AbortController
  readonly done: Promise<void>
}

type TurnOutcome = 'committed' | 'interrupted' | 'timeout' | 'provider_failure'

/** Create one single-agent text session. */
export function createTextSessionDriver(options: CreateTextSessionDriverOptions): SessionDriver {
  return new TextSessionDriver(options)
}

class TextSessionDriver implements SessionDriver {
  readonly sessionId: string
  readonly events: AsyncIterable<SessionEvent>

  readonly #queue = new AsyncEventQueue<SessionEvent>()
  readonly #clock: Clock
  readonly #model: TextModelPort
  readonly #lang: SessionLanguage
  readonly #personaId: string
  readonly #grantTtlMs: number
  readonly #messages: TextModelMessage[] = []

  #closed = false
  #turnCounter = 0
  #active: ActiveTurn | undefined

  constructor(options: CreateTextSessionDriverOptions) {
    this.sessionId = options.sessionId
    this.#clock = options.clock
    this.#model = options.model
    this.#lang = options.lang
    this.#personaId = options.personaId ?? DEFAULT_PERSONA_ID
    this.#grantTtlMs = options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS
    this.events = this.#queue

    this.#emit('session.started', {
      sessionId: options.sessionId,
      clockMode: options.clockMode ?? 'simulated',
      lang: options.lang,
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    })
  }

  async send(text: string): Promise<void> {
    if (this.#closed) throw new SessionClosedError()
    if (text.trim() === '') throw new SessionDriverError('an utterance must not be empty')

    // A new utterance supersedes an in-flight reply: one writer at a time.
    if (this.#active !== undefined) await this.interrupt()
    if (this.#closed) throw new SessionClosedError()

    this.#emit('user.utterance.committed', { text })
    this.#messages.push({ role: 'user', content: text })

    this.#turnCounter += 1
    const turnId = `${this.sessionId}-turn-${this.#turnCounter}`
    const grantId = `${this.sessionId}-grant-${this.#turnCounter}`
    const expiresAtMs = this.#clock.now() + this.#grantTtlMs

    this.#emit('turn.opened', { turnId })
    this.#emit('turn.granted', {
      grant: {
        turnId,
        grantId,
        personaId: this.#personaId,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    })

    await this.#runTurn({ turnId, grantId, expiresAtMs })
  }

  async interrupt(): Promise<void> {
    const active = this.#active
    if (active === undefined) return
    active.controller.abort()
    await active.done
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.interrupt()
    this.#emit('session.completed', {})
    this.#queue.close()
  }

  #emit<Name extends SessionEventName>(type: Name, payload: EventPayloadFor<Name>): void {
    this.#queue.push({ type, payload } as SessionEvent)
  }

  async #runTurn(turn: { turnId: string; grantId: string; expiresAtMs: number }): Promise<void> {
    const controller = new AbortController()
    let resolveDone: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })

    this.#active = { ...turn, controller, done }
    try {
      await this.#streamResponse(turn, controller)
    } finally {
      this.#active = undefined
      resolveDone()
    }
  }

  async #streamResponse(
    turn: { readonly grantId: string; readonly expiresAtMs: number },
    controller: AbortController,
  ): Promise<void> {
    this.#emit('persona.response.started', { grantId: turn.grantId })

    let text = ''
    let sequence = 0
    let sawDone = false
    let outcome: TurnOutcome = 'committed'
    let iterator: AsyncIterator<TextModelChunk> | undefined

    try {
      iterator = this.#model
        .complete(
          { messages: [...this.#messages], metadata: { lang: this.#lang } },
          { signal: controller.signal },
        )
        [Symbol.asyncIterator]()

      while (true) {
        if (controller.signal.aborted) {
          outcome = 'interrupted'
          break
        }
        if (this.#clock.now() >= turn.expiresAtMs) {
          outcome = 'timeout'
          break
        }

        const next = await iterator.next()
        if (next.done === true) break

        const chunk = next.value
        if (controller.signal.aborted) {
          outcome = 'interrupted'
          break
        }
        if (sawDone) {
          // The provider kept streaming after its final chunk.
          outcome = 'provider_failure'
          break
        }
        if (typeof chunk.text !== 'string') {
          outcome = 'provider_failure'
          break
        }

        if (chunk.text.length > 0) {
          this.#emit('persona.response.chunk', {
            grantId: turn.grantId,
            text: chunk.text,
            sequence,
          })
          text += chunk.text
          sequence += 1
        }
        if (chunk.done) sawDone = true
      }

      if (outcome === 'committed' && !sawDone) outcome = 'provider_failure'
    } catch {
      // A failed model call is not a "no": it is an interrupted reply, never a
      // fabricated or empty committed one. The caller decides whether to retry.
      outcome = controller.signal.aborted ? 'interrupted' : 'provider_failure'
    } finally {
      if (iterator?.return !== undefined) {
        try {
          await iterator.return()
        } catch {
          // A failing close after a failed stream must not mask the outcome.
        }
      }
    }

    if (outcome === 'committed') {
      this.#emit('persona.response.committed', { grantId: turn.grantId, text })
      this.#messages.push({ role: 'assistant', content: text })
      return
    }

    // Partial output is preserved as context and marked interrupted (§2.1), so
    // the next turn can see what was already said.
    if (text.length > 0) this.#messages.push({ role: 'assistant', content: text })

    const reason =
      outcome === 'timeout'
        ? 'timeout'
        : outcome === 'interrupted'
          ? 'interrupted'
          : 'provider_failure'

    this.#emit('persona.response.cancelled', {
      grantId: turn.grantId,
      reason,
      ...(text.length === 0 ? {} : { partialText: text }),
    })
  }
}
