import type { Clock } from '@rp/shared'
import type {
  PersonaSession,
  PersonaTurnPolicy,
  SessionArbiterPort,
  TurnContextInput,
} from './arbiter-port.js'
import { AsyncEventQueue, DEFAULT_MAX_QUEUED_EVENTS } from './event-queue.js'
import { SessionClosedError, SessionDriverError } from './errors.js'
import {
  type ClockMode,
  type EventPayloadFor,
  type SessionEvent,
  type SessionEventName,
  type SessionLanguage,
  type TextModelUsage,
} from './events.js'
import { MultiPersonaSessionDriver } from './multi-persona-driver.js'
import type { TextModelChunk, TextModelMessage, TextModelPort } from './model-port.js'
import { MAX_ITERATOR_CLOSE_MS, describeModelError, settleWithin } from './stream-utils.js'

export { SessionClosedError, SessionDriverError } from './errors.js'
export { AsyncEventQueue } from './event-queue.js'

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
 * The driver reads the injected `Clock` for grant expiry and uses a wall-clock
 * timer only to enforce that expiry against a silent provider. It has no
 * module-level randomness and makes no random choice in M1.
 */

export interface CreateTextSessionDriverOptions<State = unknown, Context = unknown> {
  /** Minted once per process; never reused across restarts (M1 D3). */
  readonly sessionId: string
  readonly lang: SessionLanguage
  /**
   * Prepared system instructions (M2 D4). Prepended to every model request and
   * kept out of the rolling history, so trimming can never drop them.
   */
  readonly instructions?: readonly TextModelMessage[]
  /**
   * Instructions for the opening turn only. The two-bucket prompt uses the
   * greeting pack alone for the first turn and the full pack afterwards.
   * Defaults to `instructions` when absent.
   */
  readonly greetingInstructions?: readonly TextModelMessage[]
  /**
   * Canonical BCP 47 locale (M2 D4). `lang` stays the base language; the locale
   * is a separate stamp used for prompt selection and cached-request identity.
   */
  readonly locale?: string
  /** Present only when the session replays a registered task. */
  readonly taskId?: string
  /** `wall` for a live session, `simulated` in tests and replay. */
  readonly clockMode?: ClockMode
  readonly clock: Clock
  /**
   * Single-persona model. Required when `personas` is absent; multi-persona
   * sessions supply one model per `PersonaSession` instead.
   */
  readonly model?: TextModelPort
  /** Defaults to `persona-1`; M1 has exactly one speaker. */
  readonly personaId?: string
  /** Implicit grant lifetime. Defaults to 60 seconds of injected clock time. */
  readonly grantTtlMs?: number
  /**
   * Keep at most this many recent messages in the model context. Defaults to
   * 200. Older messages are dropped so a long live session cannot grow without
   * bound; M1 has no summarisation policy.
   */
  readonly maxHistoryMessages?: number
  /**
   * Maximum undelivered events before the session fails. Defaults to 100,000.
   * A normal session never reaches it; the bound turns a stuck consumer into a
   * clear error instead of unbounded memory growth.
   */
  readonly maxQueuedEvents?: number
  /**
   * M3b: one entry per persona. When present the multi-persona driver runs and
   * `arbiter`, `policy` and `buildContext` are required. Absent keeps the
   * single-persona path exactly as it was.
   */
  readonly personas?: readonly PersonaSession[]
  /** Injected pure reducer. Required with `personas`; see `arbiter-port.ts`. */
  readonly arbiter?: SessionArbiterPort<State, Context>
  /** Per-persona turn policy. Required with `personas`. */
  readonly policy?: PersonaTurnPolicy<Context>
  /** Builds the opaque routing context for one turn. Required with `personas`. */
  readonly buildContext?: (input: TurnContextInput) => Context
  /**
   * Tie-break seed for one turn. Injected so a trial's RNG stream stays
   * reproducible; the reducer never sees a random source.
   */
  readonly seedSource?: () => number
  /**
   * Bounded request window. It also bounds each policy decision and is the
   * deadline the driver uses to close an unfinished window, so it must match the
   * arbiter's `requestWindowMs`. Defaults to 1,500 ms.
   */
  readonly requestWindowMs?: number
}

export interface SessionDriver {
  readonly sessionId: string
  /** One consumer. Events are yielded as they are produced, not after the turn. */
  readonly events: AsyncIterable<SessionEvent>
  /**
   * Open the first persona turn without a learner utterance (M2 D4). This is
   * the text-only proxy for pickup → first word and uses the same grant
   * machinery as `send()`.
   */
  start(): Promise<void>
  /** Commit one user utterance and stream the reply. Resolves when the turn ends. */
  send(text: string): Promise<void>
  /** Abort the in-flight reply. No-op when nothing is streaming. */
  interrupt(): Promise<void>
  /** Abort anything in flight, emit `session.completed`, and end the event stream. */
  close(): Promise<void>
}

const DEFAULT_GRANT_TTL_MS = 60_000
const DEFAULT_MAX_HISTORY_MESSAGES = 200
const DEFAULT_PERSONA_ID = 'persona-1'

interface ActiveTurn {
  readonly turnId: string
  readonly grantId: string
  readonly expiresAtMs: number
  readonly greeting: boolean
  readonly controller: AbortController
  readonly done: Promise<void>
}

type TurnOutcome = 'committed' | 'interrupted' | 'timeout' | 'provider_failure'

/**
 * Create one text session. With `personas` the multi-persona driver runs; with
 * `model`/`personaId` the single-agent path is unchanged.
 */
export function createTextSessionDriver<State = unknown, Context = unknown>(
  options: CreateTextSessionDriverOptions<State, Context>,
): SessionDriver {
  return options.personas === undefined
    ? new TextSessionDriver(options)
    : new MultiPersonaSessionDriver(options)
}

class TextSessionDriver<State = unknown, Context = unknown> implements SessionDriver {
  readonly sessionId: string
  readonly events: AsyncIterable<SessionEvent>

  readonly #queue: AsyncEventQueue<SessionEvent>
  readonly #clock: Clock
  readonly #model: TextModelPort
  readonly #lang: SessionLanguage
  readonly #locale: string | undefined
  readonly #instructions: readonly TextModelMessage[]
  readonly #greetingInstructions: readonly TextModelMessage[]
  readonly #personaId: string
  readonly #grantTtlMs: number
  readonly #maxHistoryMessages: number
  readonly #messages: TextModelMessage[] = []

  #closed = false
  #closing: Promise<void> | undefined
  #turnCounter = 0
  #active: ActiveTurn | undefined
  /** True once a greeting has committed; trimming must never drop it. */
  #greetingCommitted = false

  constructor(options: CreateTextSessionDriverOptions<State, Context>) {
    if (options.model === undefined) {
      throw new SessionDriverError('the single-persona path requires a model')
    }
    this.sessionId = options.sessionId
    this.#clock = options.clock
    this.#model = options.model
    this.#lang = options.lang
    this.#locale = options.locale
    this.#instructions = [...(options.instructions ?? [])]
    this.#greetingInstructions = [...(options.greetingInstructions ?? options.instructions ?? [])]
    this.#personaId = options.personaId ?? DEFAULT_PERSONA_ID
    this.#grantTtlMs = options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS
    this.#maxHistoryMessages = options.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES
    if (!Number.isInteger(this.#grantTtlMs) || this.#grantTtlMs < 1) {
      throw new SessionDriverError('grantTtlMs must be a positive integer')
    }
    if (!Number.isInteger(this.#maxHistoryMessages) || this.#maxHistoryMessages < 1) {
      throw new SessionDriverError('maxHistoryMessages must be a positive integer')
    }
    this.#queue = new AsyncEventQueue<SessionEvent>(
      options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS,
    )
    this.events = this.#queue

    this.#emit('session.started', {
      sessionId: options.sessionId,
      clockMode: options.clockMode ?? 'simulated',
      lang: options.lang,
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    })
  }

  async start(): Promise<void> {
    if (this.#closed) throw new SessionClosedError()
    if (this.#messages.length > 0 || this.#turnCounter > 0) {
      throw new SessionDriverError('start() only opens an empty session')
    }

    if (this.#active !== undefined) await this.interrupt()
    if (this.#closed) throw new SessionClosedError()

    await this.#openTurn(true)
  }

  async send(text: string): Promise<void> {
    if (this.#closed) throw new SessionClosedError()
    if (text.trim() === '') throw new SessionDriverError('an utterance must not be empty')

    // A new utterance supersedes an in-flight reply: one writer at a time.
    if (this.#active !== undefined) await this.interrupt()
    if (this.#closed) throw new SessionClosedError()

    this.#emit('user.utterance.committed', { text })
    this.#appendMessage({ role: 'user', content: text })

    await this.#openTurn(false)
  }

  async #openTurn(greeting: boolean): Promise<void> {
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

    await this.#runTurn({ turnId, grantId, expiresAtMs, greeting })
  }

  async interrupt(): Promise<void> {
    const active = this.#active
    if (active === undefined) return
    active.controller.abort()
    await active.done
  }

  async close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    this.#closed = true
    this.#closing = (async () => {
      await this.interrupt()
      this.#emit('session.completed', {})
      this.#queue.close()
    })()
    return this.#closing
  }

  #emit<Name extends SessionEventName>(type: Name, payload: EventPayloadFor<Name>): void {
    this.#queue.push({ type, payload } as SessionEvent)
  }

  #appendMessage(message: TextModelMessage): void {
    this.#messages.push(message)
    const overflow = this.#messages.length - this.#maxHistoryMessages
    if (overflow <= 0) return

    // The greeting is the first assistant turn and is part of the session's
    // identity; trimming starts after it so a long conversation cannot drop it.
    const protectedCount = this.#greetingCommitted ? 1 : 0
    this.#messages.splice(protectedCount, overflow)

    // Keep the retained context starting with a user turn after the greeting.
    // Chat-completions APIs accept an assistant-first history, but a
    // user/assistant pair is clearer and avoids dropping the user turn that the
    // assistant reply answers.
    while (this.#messages[protectedCount]?.role === 'assistant') {
      this.#messages.splice(protectedCount, 1)
    }
  }

  async #runTurn(turn: {
    turnId: string
    grantId: string
    expiresAtMs: number
    greeting: boolean
  }): Promise<void> {
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
    turn: {
      readonly turnId: string
      readonly grantId: string
      readonly expiresAtMs: number
      readonly greeting: boolean
    },
    controller: AbortController,
  ): Promise<void> {
    this.#emit('persona.response.started', { grantId: turn.grantId })

    let text = ''
    let sequence = 0
    let sawDone = false
    let usage: TextModelUsage | undefined
    let outcome: TurnOutcome = 'committed'
    let failureDetail: string | undefined
    let iterator: AsyncIterator<TextModelChunk> | undefined
    let deadlineTimer: NodeJS.Timeout | undefined

    try {
      iterator = this.#model
        .complete(
          {
            messages: [
              ...(turn.greeting ? this.#greetingInstructions : this.#instructions),
              ...this.#messages,
            ],
            metadata: {
              lang: this.#lang,
              ...(this.#locale === undefined ? {} : { locale: this.#locale }),
            },
            requestId: turn.turnId,
          },
          { signal: controller.signal },
        )
        [Symbol.asyncIterator]()

      // A grant is a real deadline, not only a boundary check. The timer ends a
      // silent provider; the abort promise ends an in-flight read when the caller
      // interrupts, even if the provider ignores the abort signal.
      const remainingMs = Math.max(0, turn.expiresAtMs - this.#clock.now())
      const deadline = new Promise<'deadline'>((resolve) => {
        deadlineTimer = setTimeout(() => resolve('deadline'), remainingMs)
      })
      const aborted = new Promise<'aborted'>((resolve) => {
        if (controller.signal.aborted) {
          resolve('aborted')
          return
        }
        controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
      })

      while (true) {
        if (controller.signal.aborted) {
          outcome = 'interrupted'
          break
        }
        if (this.#clock.now() >= turn.expiresAtMs) {
          // A simulated-clock expiry must stop the provider exactly like the
          // deadline timer does; a provider may listen only to the signal.
          controller.abort()
          outcome = 'timeout'
          break
        }

        const next = await Promise.race([
          iterator.next().then((value) => ({ kind: 'next' as const, value })),
          deadline.then(() => ({ kind: 'deadline' as const })),
          aborted.then(() => ({ kind: 'aborted' as const })),
        ])

        if (next.kind === 'deadline') {
          controller.abort()
          outcome = 'timeout'
          break
        }
        if (next.kind === 'aborted') {
          outcome = 'interrupted'
          break
        }

        if (next.value.done === true) break

        const chunk = next.value.value
        if (controller.signal.aborted) {
          outcome = 'interrupted'
          break
        }
        if (sawDone) {
          // The provider kept streaming after its final chunk.
          outcome = 'provider_failure'
          failureDetail = 'provider yielded a chunk after the final chunk'
          break
        }
        if (typeof chunk.text !== 'string') {
          outcome = 'provider_failure'
          failureDetail = 'provider yielded a non-string chunk'
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
        if (chunk.usage !== undefined) usage = chunk.usage
        if (chunk.done) sawDone = true
      }

      if (outcome === 'committed' && controller.signal.aborted) {
        // The interrupt landed while the provider was closing its stream.
        outcome = 'interrupted'
      } else if (outcome === 'committed' && !sawDone) {
        outcome = 'provider_failure'
        failureDetail = 'stream ended without a final chunk'
      }
    } catch (error) {
      // A failed model call is not a "no": it is an interrupted reply, never a
      // fabricated or empty committed one. The caller decides whether to retry.
      if (controller.signal.aborted) {
        outcome = 'interrupted'
      } else {
        outcome = 'provider_failure'
        failureDetail = describeModelError(error)
      }
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      const closeIterator = iterator
      const close = (async () => {
        try {
          await closeIterator?.return?.()
        } catch {
          // A failing close after a failed stream must not mask the outcome.
        }
      })()
      await settleWithin(close, MAX_ITERATOR_CLOSE_MS)
    }

    if (outcome === 'committed') {
      this.#emit('persona.response.committed', {
        grantId: turn.grantId,
        text,
        ...(usage === undefined ? {} : { usage }),
      })
      this.#appendMessage({ role: 'assistant', content: text })
      if (turn.greeting) this.#greetingCommitted = true
      return
    }

    // Partial output is preserved as context and marked interrupted (§2.1), so
    // the next turn can see what was already said.
    if (text.length > 0) this.#appendMessage({ role: 'assistant', content: text })

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
      ...(failureDetail === undefined ? {} : { detail: failureDetail }),
    })
  }
}
