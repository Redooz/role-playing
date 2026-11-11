import type { RoutingContext } from '@rp/routing-policy'
import type {
  EventPayloadFor,
  PersonaId,
  RevocationReason,
  SessionEventName,
  TurnRequest,
} from '@rp/session-core'

/**
 * Contracts for the M3b pure turn arbiter.
 *
 * The reducer owns the §3.2 grant lifecycle between a committed user utterance
 * and one persona response. It is a plain function: time, the tie-break seed
 * and the routing context arrive in the input, and every observable result is
 * an effect. It never reads a clock, a random source or a provider.
 *
 * `deciding` and `closing` from the plan are synchronous steps inside the
 * reducer, not stored phases: no input boundary can observe them. The state is
 * a discriminated union so an impossible state (a window without a turn, a
 * grant phase without a grant) cannot be constructed.
 */

export type TurnArbiterPhase = 'idle' | 'window_open' | 'grant_active' | 'ended'

/** One turn that is collecting requests. */
export interface ActiveTurn {
  readonly turnId: string
  /** Public state used by the M3a comparator; it never holds labels. */
  readonly context: RoutingContext
  readonly eligiblePersonaIds: readonly PersonaId[]
  readonly seed: number
  readonly windowEndsAtMs: number
  readonly requests: readonly TurnRequest[]
  readonly declinedBy: readonly PersonaId[]
}

/** The single current grant. */
export interface ActiveGrant {
  readonly grantId: string
  readonly personaId: PersonaId
  readonly expiresAtMs: number
}

export interface ArbiterIdleState {
  readonly phase: 'idle'
  /** Monotonic per session; keeps grant ids unique across turns. */
  readonly grantsIssued: number
}

export interface ArbiterWindowState {
  readonly phase: 'window_open'
  readonly turn: ActiveTurn
  readonly grantsIssued: number
}

export interface ArbiterGrantState {
  readonly phase: 'grant_active'
  readonly grant: ActiveGrant
  readonly grantsIssued: number
}

export interface ArbiterEndedState {
  readonly phase: 'ended'
  readonly grantsIssued: number
}

export type ArbiterState =
  ArbiterIdleState | ArbiterWindowState | ArbiterGrantState | ArbiterEndedState

/** A committed user utterance opens the request window. */
export interface UserCommittedInput {
  readonly kind: 'user_committed'
  readonly turnId: string
  readonly nowMs: number
  readonly seed: number
  readonly context: RoutingContext
  readonly eligiblePersonaIds: readonly PersonaId[]
}

/** A persona asks for the turn. Late, duplicate and invalid requests are dropped. */
export interface RequestInput {
  readonly kind: 'request'
  readonly request: TurnRequest
  readonly nowMs: number
}

/** A persona declines this turn. */
export interface DeclinedInput {
  readonly kind: 'declined'
  readonly turnId: string
  readonly personaId: PersonaId
  readonly nowMs: number
}

/** Lets the reducer close the window or expire a grant without another input. */
export interface TickInput {
  readonly kind: 'tick'
  readonly nowMs: number
}

/** The current grant holder stopped producing output. */
export interface ResponseEndedInput {
  readonly kind: 'response_ended'
  readonly grantId: string
  readonly outcome: 'completed' | 'cancelled'
  readonly nowMs: number
}

/** End the session; idempotent. */
export interface CloseInput {
  readonly kind: 'close'
  readonly nowMs: number
}

export type ArbiterInput =
  UserCommittedInput | RequestInput | DeclinedInput | TickInput | ResponseEndedInput | CloseInput

export type EmitEventEffect = {
  readonly [Name in SessionEventName]: {
    readonly kind: 'emit_event'
    readonly type: Name
    readonly payload: EventPayloadFor<Name>
  }
}[SessionEventName]

export type ArbiterEffect =
  | EmitEventEffect
  | {
      readonly kind: 'start_generation'
      readonly grantId: string
      readonly personaId: PersonaId
    }
  | {
      readonly kind: 'cancel_generation'
      readonly grantId: string
      readonly reason: RevocationReason
    }
  | { readonly kind: 'close_session' }

export interface ArbiterResult {
  readonly state: ArbiterState
  readonly effects: readonly ArbiterEffect[]
}
