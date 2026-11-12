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
 *
 * D2 adds interjection, partial sequencing, the recovery matrix and the streak
 * cap. Session-wide counters live in one object so every phase carries them.
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
  /** Personas whose policy call timed out or errored; never a decline. */
  readonly failedBy: readonly PersonaId[]
}

/** The single current grant. */
export interface ActiveGrant {
  readonly grantId: string
  readonly personaId: PersonaId
  readonly expiresAtMs: number
  /** First instant another persona may evaluate an interjection. */
  readonly interjectableFromMs: number
  /** End of the bounded interject opportunity; requests at or after it expire. */
  readonly interjectWindowEndsAtMs: number
  /** Highest accepted partial sequence; `-1` before the first partial. */
  readonly lastPartialSequence: number
  readonly interjects: readonly TurnRequest[]
  /** Set once the opportunity has been resolved, so it cannot run twice. */
  readonly interjectWindowClosed: boolean
  /** Replacement grants already consumed by this grant. */
  readonly replacementAttempts: number
}

/** One successful interjection, kept for the per-persona cooldown. */
export interface InterjectionRecord {
  readonly personaId: PersonaId
  readonly atMs: number
}

/** Session-wide counters; they survive phase changes. */
export interface ArbiterCounters {
  /** Monotonic per session; keeps grant ids unique across turns. */
  readonly grantsIssued: number
  /** Consecutive grants issued without a new user utterance. */
  readonly agentOnlyTurns: number
  /** Consecutive provider failures; reset by a completed response. */
  readonly consecutiveFailures: number
  readonly interjections: readonly InterjectionRecord[]
}

export interface ArbiterIdleState {
  readonly phase: 'idle'
  readonly counters: ArbiterCounters
}

export interface ArbiterWindowState {
  readonly phase: 'window_open'
  readonly turn: ActiveTurn
  readonly counters: ArbiterCounters
}

export interface ArbiterGrantState {
  readonly phase: 'grant_active'
  readonly grant: ActiveGrant
  /**
   * The turn the grant belongs to. Kept through the grant so a failed holder
   * can be replaced by the best persona that already asked to speak.
   */
  readonly turn: ActiveTurn
  readonly counters: ArbiterCounters
}

export interface ArbiterEndedState {
  readonly phase: 'ended'
  readonly counters: ArbiterCounters
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

/**
 * A persona asks for the turn. A `speak` request belongs to the open window;
 * an `interject` request names the active grant and its bounded opportunity.
 */
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

/**
 * A persona's policy call timed out or errored; this is not a decline.
 *
 * `cause` is carried for the transport and its logs. The arbiter treats both
 * causes the same way: the persona did not answer, so it cannot be counted as
 * having declined.
 */
export interface PolicyFailedInput {
  readonly kind: 'policy_failed'
  readonly turnId: string
  readonly personaId: PersonaId
  readonly cause: 'timeout' | 'error'
  readonly nowMs: number
}

/** A streamed fragment of the active grant's response. */
export interface PartialInput {
  readonly kind: 'partial'
  readonly grantId: string
  /** Speaker text carried by `persona.utterance.partial`; never stored. */
  readonly text: string
  readonly sequence: number
  readonly nowMs: number
}

/** The learner spoke over the active grant or the open window. */
export interface UserBargeInInput {
  readonly kind: 'user_barge_in'
  readonly nowMs: number
}

/** Lets the reducer close the window, resolve interjects or expire a grant. */
export interface TickInput {
  readonly kind: 'tick'
  readonly nowMs: number
}

/** The current grant holder stopped producing output. */
export interface ResponseEndedInput {
  readonly kind: 'response_ended'
  readonly grantId: string
  readonly outcome: 'completed' | 'cancelled' | 'failed'
  readonly nowMs: number
}

/** End the session; idempotent. */
export interface CloseInput {
  readonly kind: 'close'
  readonly nowMs: number
}

export type ArbiterInput =
  | UserCommittedInput
  | RequestInput
  | DeclinedInput
  | PolicyFailedInput
  | PartialInput
  | UserBargeInInput
  | TickInput
  | ResponseEndedInput
  | CloseInput

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
