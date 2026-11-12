import type {
  SessionArbiterEffect,
  SessionArbiterInput,
  SessionArbiterPort,
} from './arbiter-port.js'
import type { RevocationReason, SessionEvent, TurnGrant } from './events.js'

/**
 * Adapts the pure arbiter's effects to driver actions.
 *
 * The bridge owns the reducer state, serializes reductions so two policy
 * promises cannot interleave their effects, and exposes only the facts the
 * driver needs: the next generation to start, the current grant's turn and
 * deadline, and the request to end the session. It never emits policy events.
 */

export interface ArbiterBridgeHost {
  /** Push one already-shaped session event onto the driver's queue. */
  push(event: SessionEvent): void
  /** Abort the matching generation, if it is the current one. */
  cancel(grantId: string, reason: RevocationReason): void
  /** Mark the session ended and close the event stream. */
  end(): void
}

export interface PendingGeneration {
  readonly grantId: string
  readonly personaId: string
}

export class ArbiterBridge<State, Context> {
  readonly #arbiter: SessionArbiterPort<State, Context>
  readonly #host: ArbiterBridgeHost
  readonly #defaultDeadlineMs: number
  readonly #now: () => number

  #state: State
  #tail: Promise<void> = Promise.resolve()
  #pendingStart: PendingGeneration | undefined
  #grantTurnId: string | undefined
  #grantExpiresAtMs: number | undefined

  constructor(
    arbiter: SessionArbiterPort<State, Context>,
    host: ArbiterBridgeHost,
    options: { readonly defaultDeadlineMs: number; readonly now: () => number },
  ) {
    this.#arbiter = arbiter
    this.#host = host
    this.#defaultDeadlineMs = options.defaultDeadlineMs
    this.#now = options.now
    this.#state = arbiter.initialState
  }

  get grantTurnId(): string | undefined {
    return this.#grantTurnId
  }

  get grantExpiresAtMs(): number | undefined {
    return this.#grantExpiresAtMs
  }

  /** Remove and return the next generation, if the arbiter issued one. */
  takePendingStart(): PendingGeneration | undefined {
    const pending = this.#pendingStart
    this.#pendingStart = undefined
    return pending
  }

  reduce(input: SessionArbiterInput<Context>): Promise<void> {
    const run = this.#tail.then(() => {
      const result = this.#arbiter.reduce(this.#state, input)
      this.#state = result.state
      for (const effect of result.effects) this.#applyEffect(effect)
    })
    this.#tail = run.catch(() => undefined)
    return run
  }

  #applyEffect(effect: SessionArbiterEffect): void {
    switch (effect.kind) {
      case 'emit_event': {
        this.#host.push({ type: effect.type, payload: effect.payload } as SessionEvent)
        if (effect.type === 'turn.granted') {
          const { grant } = effect.payload as { grant: TurnGrant }
          this.#captureGrant(grant)
        }
        return
      }
      case 'start_generation': {
        this.#pendingStart = { grantId: effect.grantId, personaId: effect.personaId }
        return
      }
      case 'cancel_generation': {
        if (this.#pendingStart?.grantId === effect.grantId) this.#pendingStart = undefined
        this.#host.cancel(effect.grantId, effect.reason)
        return
      }
      case 'close_session': {
        this.#host.end()
        return
      }
    }
  }

  #captureGrant(grant: TurnGrant): void {
    this.#grantTurnId = grant.turnId
    const expiresAtMs = Date.parse(grant.expiresAt)
    this.#grantExpiresAtMs = Number.isFinite(expiresAtMs)
      ? expiresAtMs
      : this.#now() + this.#defaultDeadlineMs
  }
}
