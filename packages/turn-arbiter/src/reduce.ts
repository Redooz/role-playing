import type { TurnArbiterConfig } from './config.js'
import { emit, idleAfter, revoke, revokeEffects, unchanged } from './effects.js'
import { onPartial } from './grant.js'
import { onInterject, resolveInterjects } from './interject.js'
import { parseArbiterInput } from './input.js'
import { onResponseEnded } from './recovery.js'
import type { ArbiterCounters, ArbiterInput, ArbiterResult, ArbiterState } from './types.js'
import { decide, onDeclined, onPolicyFailed, onRequest, onUserCommitted } from './window.js'

/**
 * Pure reducer for the M3b grant lifecycle.
 *
 * D1 covers the normal turn: a bounded request window, one request per eligible
 * persona, ranking with the M3a comparator, one grant, expiry and close. D2
 * adds partial sequencing, the bounded interject opportunity, atomic
 * revoke-then-grant, the recovery matrix and the streak cap.
 *
 * Invalid and late inputs are dropped, not thrown: the reducer must stay total
 * so a fuzz run and a misbehaving transport cannot crash a live session.
 * `parseArbiterInput` validates every field at the boundary; a handler only
 * ever sees a well-typed input.
 *
 * Transitions live next to the state they own: `window.ts` collects requests,
 * `grant.ts` issues grants and carries partials, `interject.ts` resolves the
 * opportunity, and `recovery.ts` handles a failed holder. This module keeps the
 * session-level transitions and the dispatch table.
 */

export const INITIAL_COUNTERS: ArbiterCounters = Object.freeze({
  grantsIssued: 0,
  agentOnlyTurns: 0,
  consecutiveFailures: 0,
  interjections: [],
})

export const INITIAL_ARBITER_STATE: ArbiterState = Object.freeze({
  phase: 'idle',
  counters: INITIAL_COUNTERS,
})

function onTick(
  state: ArbiterState,
  input: Extract<ArbiterInput, { kind: 'tick' }>,
  config: TurnArbiterConfig,
): ArbiterResult {
  if (state.phase === 'grant_active') {
    if (input.nowMs >= state.grant.expiresAtMs) {
      return revoke(state, 'timeout', true)
    }
    if (!state.grant.interjectWindowClosed && input.nowMs >= state.grant.interjectWindowEndsAtMs) {
      return resolveInterjects(state, input.nowMs, config)
    }
    return unchanged(state)
  }

  if (state.phase === 'window_open' && input.nowMs >= state.turn.windowEndsAtMs) {
    // A window that reached its deadline with an unfinished set of responses
    // never saw every eligible persona answer, so the yield is a timeout.
    return decide(state, input.nowMs, config, 'policy_timeout')
  }

  return unchanged(state)
}

/**
 * The learner spoke over the session. Barge-in always wins and needs no model
 * call: the active grant is revoked with `user_barge_in`, and an open request
 * window is discarded because the next utterance supersedes it.
 */
function onUserBargeIn(state: ArbiterState): ArbiterResult {
  if (state.phase === 'grant_active') {
    return {
      state: idleAfter(state.counters),
      effects: [
        emit('user.barge_in', { targetGrantId: state.grant.grantId }),
        ...revokeEffects(state.grant.grantId, 'user_barge_in'),
      ],
    }
  }
  if (state.phase === 'window_open') {
    return { state: idleAfter(state.counters), effects: [emit('user.barge_in', {})] }
  }
  return unchanged(state)
}

function onClose(state: ArbiterState): ArbiterResult {
  if (state.phase === 'ended') return unchanged(state)

  const revoked =
    state.phase === 'grant_active' ? revokeEffects(state.grant.grantId, 'session_completed') : []
  return {
    state: { phase: 'ended', counters: state.counters },
    effects: [...revoked, emit('session.completed', {}), { kind: 'close_session' }],
  }
}

export function reduce(
  state: ArbiterState,
  input: ArbiterInput,
  config: TurnArbiterConfig,
): ArbiterResult {
  const valid = parseArbiterInput(input, config)
  if (valid === undefined) return unchanged(state)

  switch (valid.kind) {
    case 'user_committed':
      return onUserCommitted(state, valid, config)
    case 'request':
      return valid.request.action === 'interject'
        ? onInterject(state, valid, config)
        : onRequest(state, valid, config)
    case 'declined':
      return onDeclined(state, valid, config)
    case 'policy_failed':
      return onPolicyFailed(state, valid, config)
    case 'partial':
      return onPartial(state, valid)
    case 'user_barge_in':
      return onUserBargeIn(state)
    case 'tick':
      return onTick(state, valid, config)
    case 'response_ended':
      return onResponseEnded(state, valid, config)
    case 'close':
      return onClose(state)
  }
}
