import type { EventPayloadFor, RevocationReason, SessionEventName } from '@rp/session-core'
import type {
  ArbiterCounters,
  ArbiterEffect,
  ArbiterGrantState,
  ArbiterResult,
  ArbiterState,
  EmitEventEffect,
} from './types.js'

/**
 * Result and effect builders shared by every transition.
 *
 * Keeping the revoke pair in one place means a timeout, an interjection, a
 * provider failure, a barge-in and a close cannot disagree about which effects
 * end the current grant.
 */

export function emit<Name extends SessionEventName>(
  type: Name,
  payload: EventPayloadFor<Name>,
): EmitEventEffect {
  return { kind: 'emit_event', type, payload } as EmitEventEffect
}

export function unchanged(state: ArbiterState): ArbiterResult {
  return { state, effects: [] }
}

export function idleAfter(counters: ArbiterCounters): ArbiterState {
  return { phase: 'idle', counters }
}

/** End the current grant: the observable revoke plus a cancelled generation. */
export function revokeEffects(grantId: string, reason: RevocationReason): ArbiterEffect[] {
  return [emit('turn.revoked', { grantId, reason }), { kind: 'cancel_generation', grantId, reason }]
}

/**
 * Revoke the active grant and return to idle, optionally cancelling generation.
 * The caller owns the counters because a failure or completion updates them.
 */
export function revoke(
  state: ArbiterGrantState,
  reason: RevocationReason,
  cancel: boolean,
  counters: ArbiterCounters = state.counters,
): ArbiterResult {
  const effects: ArbiterEffect[] = cancel
    ? revokeEffects(state.grant.grantId, reason)
    : [emit('turn.revoked', { grantId: state.grant.grantId, reason })]
  return { state: idleAfter(counters), effects }
}
