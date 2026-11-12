import type { Clock } from '@rp/shared'
import type { PersonaPolicyInput, PersonaSession } from './arbiter-port.js'
import { ArbiterBridge } from './arbiter-bridge.js'
import { ConversationHistory } from './conversation-history.js'
import type { CreateTextSessionDriverOptions, SessionDriver } from './driver.js'
import { AsyncEventQueue, DEFAULT_MAX_QUEUED_EVENTS } from './event-queue.js'
import { SessionClosedError, SessionDriverError } from './errors.js'
import type {
  EventPayloadFor,
  ResponseCancellationReason,
  RevocationReason,
  SessionEvent,
  SessionEventName,
  SessionLanguage,
} from './events.js'
import { streamGrant } from './grant-stream.js'
import { decideWithin, interjectRequestFor, speakRequestFor } from './policy-decisions.js'

/**
 * Multi-persona text session driver (M3b D3).
 *
 * One writer at a time. The pure turn arbiter chooses the speaker; this class
 * applies its effects: it emits the §2.1 events, starts exactly the granted
 * generation, and cancels the old one before a new grant can write. It never
 * inspects the arbiter state, so the reducer stays the only owner of the grant
 * lifecycle.
 *
 * Dependency direction: `@rp/turn-arbiter` imports `session-core` for the event
 * vocabulary, so this driver cannot import the reducer. It depends on
 * `SessionArbiterPort` instead and the composition root injects `reduce` with
 * its frozen config. The same holds for `PersonaTurnPolicy`.
 *
 * The greeting is the one grant this driver mints itself: it has no user
 * utterance, so no routing context exists and no policy is called. It mirrors
 * the single-persona greeting path and is not tracked by the arbiter.
 */

const DEFAULT_REQUEST_WINDOW_MS = 1_500
const DEFAULT_GREETING_TTL_MS = 60_000

interface ActiveGeneration {
  readonly grantId: string
  readonly controller: AbortController
  cancellationReason: ResponseCancellationReason
}

interface GenerationRequest {
  readonly grantId: string
  readonly personaId: string
  readonly turnId: string
  readonly expiresAtMs: number
  readonly greeting: boolean
  /** False for the driver-minted greeting, which the arbiter never sees. */
  readonly tracked: boolean
}

/** Map an arbiter revocation to the reason carried by `persona.response.cancelled`. */
function cancellationFor(reason: RevocationReason): ResponseCancellationReason {
  if (reason === 'user_barge_in') return 'user_barge_in'
  if (reason === 'timeout') return 'timeout'
  return 'revoked'
}

export class MultiPersonaSessionDriver<
  State = unknown,
  Context = unknown,
> implements SessionDriver {
  readonly sessionId: string
  readonly events: AsyncIterable<SessionEvent>

  readonly #queue: AsyncEventQueue<SessionEvent>
  readonly #clock: Clock
  readonly #lang: SessionLanguage
  readonly #locale: string | undefined
  readonly #personas: readonly PersonaSession[]
  readonly #personaById: ReadonlyMap<string, PersonaSession>
  readonly #openingPersonaId: string
  readonly #bridge: ArbiterBridge<State, Context>
  readonly #policy: NonNullable<CreateTextSessionDriverOptions<State, Context>['policy']>
  readonly #buildContext: NonNullable<
    CreateTextSessionDriverOptions<State, Context>['buildContext']
  >
  readonly #seedSource: () => number
  readonly #requestWindowMs: number
  readonly #history: ConversationHistory

  #turnContext: Context | undefined
  #turnDone: Promise<void> | undefined
  #active: ActiveGeneration | undefined
  #declinedThisTurn = new Set<string>()
  #failedThisTurn = new Set<string>()
  #turnCounter = 0
  #closed = false
  #closing: Promise<void> | undefined

  constructor(options: CreateTextSessionDriverOptions<State, Context>) {
    if (options.personaId !== undefined) {
      throw new SessionDriverError('personaId is for single-persona mode; use personas instead')
    }
    if (options.arbiter === undefined || options.policy === undefined) {
      throw new SessionDriverError('personas require an arbiter and a policy')
    }
    if (options.buildContext === undefined) {
      throw new SessionDriverError('personas require a buildContext function')
    }
    const personas = options.personas ?? []
    if (personas.length === 0) throw new SessionDriverError('personas must not be empty')
    const personaById = new Map<string, PersonaSession>()
    for (const persona of personas) {
      if (persona.personaId.trim() === '') {
        throw new SessionDriverError('a persona id must not be empty')
      }
      if (personaById.has(persona.personaId)) {
        throw new SessionDriverError(`duplicate persona id "${persona.personaId}"`)
      }
      personaById.set(persona.personaId, persona)
    }

    this.sessionId = options.sessionId
    this.#clock = options.clock
    this.#lang = options.lang
    this.#locale = options.locale
    this.#personas = personas
    this.#personaById = personaById
    this.#openingPersonaId = personas[0]!.personaId
    this.#policy = options.policy
    this.#buildContext = options.buildContext
    this.#seedSource = options.seedSource ?? (() => Math.random())
    this.#requestWindowMs = options.requestWindowMs ?? DEFAULT_REQUEST_WINDOW_MS
    this.#history = new ConversationHistory(options.maxHistoryMessages ?? 200)
    if (!Number.isInteger(this.#requestWindowMs) || this.#requestWindowMs < 1) {
      throw new SessionDriverError('requestWindowMs must be a positive integer')
    }

    this.#queue = new AsyncEventQueue<SessionEvent>(
      options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS,
    )
    this.events = this.#queue
    this.#bridge = new ArbiterBridge(
      options.arbiter,
      {
        push: (event) => this.#queue.push(event),
        cancel: (grantId, reason) => {
          const active = this.#active
          if (active?.grantId === grantId) {
            active.cancellationReason = cancellationFor(reason)
            active.controller.abort()
          }
        },
        end: () => {
          this.#closed = true
          this.#queue.close()
        },
      },
      { defaultDeadlineMs: DEFAULT_GREETING_TTL_MS, now: () => this.#clock.now() },
    )

    this.#emit('session.started', {
      sessionId: options.sessionId,
      clockMode: options.clockMode ?? 'simulated',
      lang: options.lang,
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    })
  }

  async start(): Promise<void> {
    if (this.#closed) throw new SessionClosedError()
    if (this.#history.length > 0 || this.#turnCounter > 0) {
      throw new SessionDriverError('start() only opens an empty session')
    }

    await this.#interrupt()

    this.#turnCounter += 1
    const turnId = `${this.sessionId}-turn-${this.#turnCounter}`
    const grantId = `${this.sessionId}-grant-greeting-${this.#turnCounter}`
    const expiresAtMs = this.#clock.now() + DEFAULT_GREETING_TTL_MS
    this.#emit('turn.opened', { turnId })
    this.#emit('turn.granted', {
      grant: {
        turnId,
        grantId,
        personaId: this.#openingPersonaId,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    })

    await this.#trackTurn(
      this.#runGeneration({
        grantId,
        personaId: this.#openingPersonaId,
        turnId,
        expiresAtMs,
        greeting: true,
        tracked: false,
      }),
    )
  }

  async send(text: string): Promise<void> {
    if (this.#closed) throw new SessionClosedError()
    if (text.trim() === '') throw new SessionDriverError('an utterance must not be empty')

    // A new utterance supersedes an in-flight reply; the arbiter revokes it.
    await this.#interrupt()
    if (this.#closed) throw new SessionClosedError()

    this.#emit('user.utterance.committed', { text })
    this.#history.append({ role: 'user', content: text })
    this.#turnCounter += 1

    const turnId = `${this.sessionId}-turn-${this.#turnCounter}`
    await this.#trackTurn(this.#driveTurn({ turnId, userText: text }))
  }

  async interrupt(): Promise<void> {
    await this.#interrupt()
  }

  async close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    this.#closed = true
    this.#closing = (async () => {
      this.#active?.controller.abort()
      await this.#turnDone
      await this.#bridge.reduce({ kind: 'close', nowMs: this.#clock.now() })
      this.#queue.close()
    })()
    return this.#closing
  }

  async #interrupt(): Promise<void> {
    const done = this.#turnDone
    if (done === undefined) return
    await this.#bridge.reduce({ kind: 'user_barge_in', nowMs: this.#clock.now() })
    this.#active?.controller.abort()
    await done
  }

  async #trackTurn(run: Promise<void>): Promise<void> {
    this.#turnDone = run
    try {
      await run
    } finally {
      if (this.#turnDone === run) this.#turnDone = undefined
    }
  }

  async #driveTurn(params: { readonly turnId: string; readonly userText: string }): Promise<void> {
    this.#declinedThisTurn.clear()
    this.#failedThisTurn.clear()

    const context = this.#buildContext({
      turnId: params.turnId,
      messages: [...this.#history.messages],
      userText: params.userText,
    })
    this.#turnContext = context
    const seed = this.#seedSource()
    const eligible = this.#personas.map((persona) => persona.personaId)

    await this.#bridge.reduce({
      kind: 'user_committed',
      turnId: params.turnId,
      nowMs: this.#clock.now(),
      seed,
      context,
      eligiblePersonaIds: eligible,
    })
    await this.#collectSpeakDecisions(params.turnId, context, eligible)

    while (!this.#closed) {
      const start = this.#bridge.takePendingStart()
      if (start === undefined) break
      await this.#runGeneration({
        grantId: start.grantId,
        personaId: start.personaId,
        turnId: this.#bridge.grantTurnId ?? params.turnId,
        expiresAtMs: this.#bridge.grantExpiresAtMs ?? this.#clock.now() + DEFAULT_GREETING_TTL_MS,
        greeting: false,
        tracked: true,
      })
    }
    this.#turnContext = undefined
  }

  async #collectSpeakDecisions(
    turnId: string,
    context: Context,
    personaIds: readonly string[],
  ): Promise<void> {
    const windowEndsAtMs = this.#clock.now() + this.#requestWindowMs

    await Promise.all(
      personaIds.map(async (personaId) => {
        const outcome = await decideWithin(
          this.#policy,
          this.#policyInput(personaId, turnId, context, 'speak'),
          this.#requestWindowMs,
        )

        if (outcome.kind === 'timeout' || outcome.kind === 'error') {
          this.#failedThisTurn.add(personaId)
          await this.#bridge.reduce({
            kind: 'policy_failed',
            turnId,
            personaId,
            cause: outcome.kind,
            nowMs: this.#clock.now(),
          })
          return
        }

        if (outcome.decision.kind === 'decline') {
          this.#declinedThisTurn.add(personaId)
          await this.#bridge.reduce({
            kind: 'declined',
            turnId,
            personaId,
            nowMs: this.#clock.now(),
          })
          return
        }

        const request = speakRequestFor(turnId, personaId, outcome.decision)
        if (request === undefined) {
          // A malformed decision is a failed policy call, never a fabricated request.
          this.#failedThisTurn.add(personaId)
          await this.#bridge.reduce({
            kind: 'policy_failed',
            turnId,
            personaId,
            cause: 'error',
            nowMs: this.#clock.now(),
          })
          return
        }

        await this.#bridge.reduce({ kind: 'request', request, nowMs: this.#clock.now() })
      }),
    )

    // The bounded window must resolve even when an input was late or malformed.
    await this.#bridge.reduce({ kind: 'tick', nowMs: Math.max(this.#clock.now(), windowEndsAtMs) })
  }

  async #collectInterjections(request: GenerationRequest): Promise<void> {
    const context = this.#turnContext
    if (context === undefined) return

    const others = this.#personas.filter(
      (persona) =>
        persona.personaId !== request.personaId &&
        !this.#declinedThisTurn.has(persona.personaId) &&
        !this.#failedThisTurn.has(persona.personaId),
    )

    await Promise.all(
      others.map(async (persona) => {
        const outcome = await decideWithin(
          this.#policy,
          this.#policyInput(
            persona.personaId,
            request.turnId,
            context,
            'interject',
            request.grantId,
          ),
          this.#requestWindowMs,
        )

        if (outcome.kind === 'timeout' || outcome.kind === 'error') {
          this.#failedThisTurn.add(persona.personaId)
          await this.#bridge.reduce({
            kind: 'policy_failed',
            turnId: request.turnId,
            personaId: persona.personaId,
            cause: outcome.kind,
            nowMs: this.#clock.now(),
          })
          return
        }
        if (outcome.decision.kind === 'decline') return

        const interject = interjectRequestFor(
          request.turnId,
          persona.personaId,
          request.grantId,
          outcome.decision,
        )
        if (interject === undefined) {
          this.#failedThisTurn.add(persona.personaId)
          await this.#bridge.reduce({
            kind: 'policy_failed',
            turnId: request.turnId,
            personaId: persona.personaId,
            cause: 'error',
            nowMs: this.#clock.now(),
          })
          return
        }

        await this.#bridge.reduce({ kind: 'request', request: interject, nowMs: this.#clock.now() })
      }),
    )
  }

  #policyInput(
    personaId: string,
    turnId: string,
    context: Context,
    action: 'speak' | 'interject',
    targetGrantId?: string,
  ): PersonaPolicyInput<Context> {
    return {
      personaId,
      turnId,
      action,
      ...(targetGrantId === undefined ? {} : { targetGrantId }),
      messages: [...this.#history.messages],
      lang: this.#lang,
      ...(this.#locale === undefined ? {} : { locale: this.#locale }),
      context,
    }
  }

  async #runGeneration(request: GenerationRequest): Promise<void> {
    const persona = this.#personaById.get(request.personaId)
    if (persona === undefined) {
      throw new SessionDriverError(`grant names unknown persona "${request.personaId}"`)
    }

    const controller = new AbortController()
    const active: ActiveGeneration = {
      grantId: request.grantId,
      controller,
      cancellationReason: 'interrupted',
    }
    this.#active = active

    try {
      const result = await streamGrant<Context>(
        { ...request, controller, cancellationReason: () => active.cancellationReason },
        persona,
        {
          clock: this.#clock,
          lang: this.#lang,
          locale: this.#locale,
          history: this.#history.messages,
          emit: (type, payload) => this.#emit(type, payload),
          reduce: (input) => this.#bridge.reduce(input),
          collectInterjections: () => this.#collectInterjections(request),
        },
      )

      if (result.outcome === 'committed') {
        this.#emit('persona.response.committed', {
          grantId: request.grantId,
          text: result.text,
          ...(result.usage === undefined ? {} : { usage: result.usage }),
        })
        this.#history.append({
          role: 'assistant',
          content: result.text,
          personaId: request.personaId,
        })
        if (request.greeting) this.#history.markGreetingCommitted()
      } else {
        // Partial output is preserved as interrupted context, never silently lost.
        if (result.text.length > 0) {
          this.#history.append({
            role: 'assistant',
            content: result.text,
            personaId: request.personaId,
          })
        }
        this.#emit('persona.response.cancelled', {
          grantId: request.grantId,
          reason: result.cancellationReason,
          ...(result.text.length === 0 ? {} : { partialText: result.text }),
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        })
      }

      if (request.tracked) {
        await this.#bridge.reduce({
          kind: 'response_ended',
          grantId: request.grantId,
          outcome: result.outcome === 'committed' ? 'completed' : result.outcome,
          nowMs: this.#clock.now(),
        })
      }
    } finally {
      this.#active = undefined
    }
  }

  #emit<Name extends SessionEventName>(type: Name, payload: EventPayloadFor<Name>): void {
    this.#queue.push({ type, payload } as SessionEvent)
  }
}
