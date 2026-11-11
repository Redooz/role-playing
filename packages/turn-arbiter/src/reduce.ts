import { rankTurnRequests } from '@rp/routing-policy'
import type { EventPayloadFor, SessionEventName, TurnGrant } from '@rp/session-core'
import type { TurnArbiterConfig } from './config.js'
import { parseArbiterInput } from './input.js'
import type {
  ActiveGrant,
  ActiveTurn,
  ArbiterEffect,
  ArbiterGrantState,
  ArbiterInput,
  ArbiterResult,
  ArbiterState,
  ArbiterWindowState,
  EmitEventEffect,
} from './types.js'

/**
 * Pure reducer for the M3b grant lifecycle.
 *
 * D1 covers the normal turn: a bounded request window, one request per eligible
 * persona, ranking with the M3a comparator, one grant, expiry and close. It
 * does not cover interjection, partials, replacement or the streak cap; those
 * transitions arrive in D2 and must not be added here.
 *
 * Invalid and late inputs are dropped, not thrown: the reducer must stay total
 * so a fuzz run and a misbehaving transport cannot crash a live session.
 * `parseArbiterInput` validates every field at the boundary; a handler only
 * ever sees a well-typed input.
 */

export const INITIAL_ARBITER_STATE: ArbiterState = Object.freeze({
  phase: 'idle',
  grantsIssued: 0,
})

function emit<Name extends SessionEventName>(
  type: Name,
  payload: EventPayloadFor<Name>,
): EmitEventEffect {
  return { kind: 'emit_event', type, payload } as EmitEventEffect
}

function unchanged(state: ArbiterState): ArbiterResult {
  return { state, effects: [] }
}

function idleAfter(state: { readonly grantsIssued: number }): ArbiterState {
  return { phase: 'idle', grantsIssued: state.grantsIssued }
}

function hasResponded(turn: ActiveTurn, personaId: string): boolean {
  return (
    turn.declinedBy.includes(personaId) ||
    turn.requests.some((request) => request.personaId === personaId)
  )
}

function isWindowComplete(turn: ActiveTurn): boolean {
  return turn.eligiblePersonaIds.every((personaId) => hasResponded(turn, personaId))
}

/**
 * Resolve the window into one grant or a learner yield.
 *
 * The comparator is the M3a post-turn ordering, so a live session and an
 * offline replay cannot disagree about who speaks next.
 *
 * The caller names the yield reason because only it knows why the window
 * closed. A complete window with no winner means every persona declined; an
 * expired window means at least one persona never answered, which is a policy
 * timeout and must never be recorded as a decline.
 */
function decide(
  state: ArbiterWindowState,
  nowMs: number,
  config: TurnArbiterConfig,
  noWinnerReason: 'all_declined' | 'policy_timeout',
): ArbiterResult {
  const winner = rankTurnRequests(state.turn.context, state.turn.requests, state.turn.seed)[0]
  if (winner === undefined) {
    return {
      state: idleAfter(state),
      effects: [emit('turn.user_yielded', { reason: noWinnerReason })],
    }
  }

  const grantsIssued = state.grantsIssued + 1
  const expiresAtMs = nowMs + config.grantTtlMs
  const grant: TurnGrant = {
    turnId: state.turn.turnId,
    grantId: `grant:${state.turn.turnId}:${grantsIssued}`,
    personaId: winner.personaId,
    expiresAt: new Date(expiresAtMs).toISOString(),
  }
  const active: ActiveGrant = {
    grantId: grant.grantId,
    personaId: grant.personaId,
    expiresAtMs,
  }

  return {
    state: { phase: 'grant_active', grant: active, grantsIssued },
    effects: [
      emit('turn.granted', { grant }),
      { kind: 'start_generation', grantId: active.grantId, personaId: active.personaId },
    ],
  }
}

function closeWindowIfComplete(
  state: ArbiterWindowState,
  turn: ActiveTurn,
  nowMs: number,
  config: TurnArbiterConfig,
  effects: readonly ArbiterEffect[],
): ArbiterResult {
  if (!isWindowComplete(turn)) {
    return { state: { ...state, turn }, effects }
  }
  const decided = decide({ ...state, turn }, nowMs, config, 'all_declined')
  return { state: decided.state, effects: [...effects, ...decided.effects] }
}

function onUserCommitted(
  state: ArbiterState,
  input: Extract<ArbiterInput, { kind: 'user_committed' }>,
  config: TurnArbiterConfig,
): ArbiterResult {
  if (state.phase !== 'idle') return unchanged(state)

  const turn: ActiveTurn = {
    turnId: input.turnId,
    context: input.context,
    eligiblePersonaIds: input.eligiblePersonaIds,
    seed: input.seed,
    windowEndsAtMs: input.nowMs + config.requestWindowMs,
    requests: [],
    declinedBy: [],
  }
  const window: ArbiterWindowState = {
    phase: 'window_open',
    turn,
    grantsIssued: state.grantsIssued,
  }
  const opened: ArbiterEffect[] = [emit('turn.opened', { turnId: input.turnId })]

  // `closeWindowIfComplete` also covers a turn with no eligible persona: the
  // empty window is complete at once and yields to the learner.
  return closeWindowIfComplete(window, turn, input.nowMs, config, opened)
}

function onRequest(
  state: ArbiterState,
  input: Extract<ArbiterInput, { kind: 'request' }>,
  config: TurnArbiterConfig,
): ArbiterResult {
  if (state.phase !== 'window_open') return unchanged(state)

  const turn = state.turn
  const request = input.request
  if (request.turnId !== turn.turnId) return unchanged(state)
  if (request.action !== 'speak') return unchanged(state)
  if (input.nowMs >= turn.windowEndsAtMs) return unchanged(state)
  if (!turn.eligiblePersonaIds.includes(request.personaId)) return unchanged(state)
  if (hasResponded(turn, request.personaId)) return unchanged(state)

  const nextTurn: ActiveTurn = { ...turn, requests: [...turn.requests, request] }
  const effects: ArbiterEffect[] = [emit('persona.requested_turn', { request })]
  return closeWindowIfComplete(state, nextTurn, input.nowMs, config, effects)
}

function onDeclined(
  state: ArbiterState,
  input: Extract<ArbiterInput, { kind: 'declined' }>,
  config: TurnArbiterConfig,
): ArbiterResult {
  if (state.phase !== 'window_open') return unchanged(state)

  const turn = state.turn
  if (input.turnId !== turn.turnId) return unchanged(state)
  if (input.nowMs >= turn.windowEndsAtMs) return unchanged(state)
  if (!turn.eligiblePersonaIds.includes(input.personaId)) return unchanged(state)
  if (hasResponded(turn, input.personaId)) return unchanged(state)

  const nextTurn: ActiveTurn = { ...turn, declinedBy: [...turn.declinedBy, input.personaId] }
  const effects: ArbiterEffect[] = [
    emit('persona.declined', { turnId: turn.turnId, personaId: input.personaId }),
  ]
  return closeWindowIfComplete(state, nextTurn, input.nowMs, config, effects)
}

function revoke(
  state: ArbiterGrantState,
  reason: 'completed' | 'cancelled' | 'timeout' | 'session_completed',
  cancel: boolean,
): ArbiterResult {
  const effects: ArbiterEffect[] = [emit('turn.revoked', { grantId: state.grant.grantId, reason })]
  if (cancel) {
    effects.push({ kind: 'cancel_generation', grantId: state.grant.grantId, reason })
  }
  return { state: idleAfter(state), effects }
}

function onTick(
  state: ArbiterState,
  input: Extract<ArbiterInput, { kind: 'tick' }>,
  config: TurnArbiterConfig,
): ArbiterResult {
  if (state.phase === 'grant_active') {
    if (input.nowMs >= state.grant.expiresAtMs) {
      // D1 revokes and returns to idle. The bounded replacement belongs to the
      // D2 recovery matrix and must not be simulated here.
      return revoke(state, 'timeout', true)
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

function onResponseEnded(
  state: ArbiterState,
  input: Extract<ArbiterInput, { kind: 'response_ended' }>,
): ArbiterResult {
  if (state.phase !== 'grant_active') return unchanged(state)
  if (state.grant.grantId !== input.grantId) return unchanged(state)

  if (input.outcome === 'completed') return revoke(state, 'completed', false)
  return revoke(state, 'cancelled', true)
}

function onClose(state: ArbiterState): ArbiterResult {
  if (state.phase === 'ended') return unchanged(state)

  const effects: ArbiterEffect[] = []
  if (state.phase === 'grant_active') {
    effects.push(
      emit('turn.revoked', { grantId: state.grant.grantId, reason: 'session_completed' }),
    )
    effects.push({
      kind: 'cancel_generation',
      grantId: state.grant.grantId,
      reason: 'session_completed',
    })
  }
  effects.push(emit('session.completed', {}))
  effects.push({ kind: 'close_session' })
  return { state: { phase: 'ended', grantsIssued: state.grantsIssued }, effects }
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
      return onRequest(state, valid, config)
    case 'declined':
      return onDeclined(state, valid, config)
    case 'tick':
      return onTick(state, valid, config)
    case 'response_ended':
      return onResponseEnded(state, valid)
    case 'close':
      return onClose(state)
  }
}
