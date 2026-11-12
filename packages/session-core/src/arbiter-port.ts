import type { RevocationReason, SessionEventName, SessionLanguage, TurnRequest } from './events.js'
import type { TextModelMessage, TextModelPort } from './model-port.js'

/**
 * Ports between the session driver and the pure M3b pieces.
 *
 * `session-core` owns the §2.1 event vocabulary, and `@rp/turn-arbiter` imports
 * it. A direct `session-core -> turn-arbiter` import would close that cycle, so
 * the driver depends on these structural ports and the composition root injects
 * the reducer and the policy. The shapes mirror `ArbiterInput`,
 * `ArbiterEffect` and `TurnPolicy`; the real reducer satisfies them
 * structurally, which `packages/turn-arbiter/src/driver-integration.spec.ts`
 * proves.
 *
 * The ports stay plain data: no provider, clock, environment or random source.
 */

/** One effect the driver must apply. It is never I/O inside the reducer. */
export type SessionArbiterEffect =
  | {
      readonly kind: 'emit_event'
      readonly type: SessionEventName
      readonly payload: unknown
    }
  | {
      readonly kind: 'start_generation'
      readonly grantId: string
      readonly personaId: string
    }
  | {
      readonly kind: 'cancel_generation'
      readonly grantId: string
      readonly reason: RevocationReason
    }
  | { readonly kind: 'close_session' }

/**
 * One reducer input. `context` is opaque to `session-core`: the composition
 * root builds the routing context and the arbiter validates it.
 */
export type SessionArbiterInput<Context = unknown> =
  | {
      readonly kind: 'user_committed'
      readonly turnId: string
      readonly nowMs: number
      readonly seed: number
      readonly context: Context
      readonly eligiblePersonaIds: readonly string[]
    }
  | {
      readonly kind: 'request'
      readonly request: TurnRequest
      readonly nowMs: number
    }
  | {
      readonly kind: 'declined'
      readonly turnId: string
      readonly personaId: string
      readonly nowMs: number
    }
  | {
      readonly kind: 'policy_failed'
      readonly turnId: string
      readonly personaId: string
      readonly cause: 'timeout' | 'error'
      readonly nowMs: number
    }
  | {
      readonly kind: 'partial'
      readonly grantId: string
      readonly text: string
      readonly sequence: number
      readonly nowMs: number
    }
  | { readonly kind: 'user_barge_in'; readonly nowMs: number }
  | { readonly kind: 'tick'; readonly nowMs: number }
  | {
      readonly kind: 'response_ended'
      readonly grantId: string
      readonly outcome: 'completed' | 'cancelled' | 'failed'
      readonly nowMs: number
    }
  | { readonly kind: 'close'; readonly nowMs: number }

/** The pure reducer as the driver sees it; `config` is bound by the caller. */
export interface SessionArbiterPort<State = unknown, Context = unknown> {
  readonly initialState: State
  reduce(
    state: State,
    input: SessionArbiterInput<Context>,
  ): {
    readonly state: State
    readonly effects: readonly SessionArbiterEffect[]
  }
}

/**
 * One message of the session history as the driver keeps it.
 *
 * Assistant messages carry the speaker so a routing context can be rebuilt
 * without adding a transcript field; model requests strip it again.
 */
export interface ConversationMessage extends TextModelMessage {
  /** Present on assistant messages in a multi-persona session. */
  readonly personaId?: string
}

/** Input to one policy decision. It never contains gold labels or arm outcomes. */
export interface PersonaPolicyInput<Context = unknown> {
  readonly personaId: string
  readonly turnId: string
  readonly action: 'speak' | 'interject'
  /** Present only for `interject`. */
  readonly targetGrantId?: string
  /** Public conversation state at decision time. */
  readonly messages: readonly ConversationMessage[]
  readonly lang: SessionLanguage
  readonly locale?: string
  /** The same opaque context the driver passed to the arbiter. */
  readonly context: Context
}

/** A persona either asks for the turn or stays silent. A failure is neither. */
export type PersonaPolicyDecision =
  { readonly kind: 'request'; readonly request: TurnRequest } | { readonly kind: 'decline' }

/** The policy port; the live control arm is deterministic and synchronous. */
export interface PersonaTurnPolicy<Context = unknown> {
  decide(input: PersonaPolicyInput<Context>): PersonaPolicyDecision | Promise<PersonaPolicyDecision>
}

/** One persona's model and prompts. The conversation history is shared. */
export interface PersonaSession {
  readonly personaId: string
  readonly model: TextModelPort
  /** System instructions for ordinary turns. */
  readonly instructions?: readonly TextModelMessage[]
  /** Instructions for the opening greeting; defaults to `instructions`. */
  readonly greetingInstructions?: readonly TextModelMessage[]
}

/** Input the driver gives the composition root to build one turn's context. */
export interface TurnContextInput {
  readonly turnId: string
  /** History including the utterance being answered. */
  readonly messages: readonly ConversationMessage[]
  /** The committed user utterance. The greeting path does not build a context. */
  readonly userText: string
}
