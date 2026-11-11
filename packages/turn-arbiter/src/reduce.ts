import { rankTurnRequests } from '@rp/routing-policy'
import type {
  EventPayloadFor,
  PersonaId,
  RevocationReason,
  SessionEventName,
  TurnGrant,
} from '@rp/session-core'
import type { TurnArbiterConfig } from './config.js'
import type {
  ActiveGrant,
  ActiveTurn,
  ArbiterEffect,
  ArbiterInput,
  ArbiterResult,
  ArbiterState,
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

function idleAfter(state: ArbiterState): ArbiterState {
  return { phase: 'idle', grantsIssued: state.grantsIssued }
}

function hasResponded(turn: ActiveTurn, personaId: PersonaId): boolean {
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
 */
function decide(
  state: ArbiterState,
  turn: ActiveTurn,
  nowMs: number,
  config: TurnArbiterConfig,
): ArbiterResult {
  const winner = rankTurnRequests(turn.context, turn.requests, turn.seed)[0]
  if (winner === undefined) {
    return {
      state: idleAfter(state),
      effects: [emit('turn.user_yielded', { reason: 'all_declined' })],
    }
  }

  const grantsIssued = state.grantsIssued + 1
  const expiresAtMs = nowMs + config.grantTtlMs
  const grant: TurnGrant = {
    turnId: turn.turnId,
    grantId: `grant:${turn.turnId}:${grantsIssued}`,
    personaId: winner.personaId,
    expiresAt: new Date(expiresAtMs).toISOString(),
  }
  const active: ActiveGrant = {
    grantId: grant.grantId,
    turnId: turn.turnId,
    personaId: grant.personaId,
    expiresAtMs,
  }

  return {
    state: { phase: 'grant_active', turn, grant: active, grantsIssued },
    effects: [
      emit('turn.granted', { grant }),
      { kind: 'start_generation', grantId: active.grantId, personaId: active.personaId },
    ],
  }
}

function closeWindowIfComplete(
  state: ArbiterState,
  turn: ActiveTurn,
  nowMs: number,
  config: TurnArbiterConfig,
  effects: readonly ArbiterEffect[],
): ArbiterResult {
  if (!isWindowComplete(turn)) {
    return { state: { ...state, turn }, effects }
  }
  const decided = decide({ ...state, turn }, turn, nowMs, config)
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
  const opened: ArbiterEffect[] = [emit('turn.opened', { turnId: input.turnId })]

  // A turn with no eligible persona is an immediate learner yield, not a window
  // that nobody can answer.
  if (turn.eligiblePersonaIds.length === 0) {
    return closeWindowIfComplete({ ...state, turn }, turn, input.nowMs, config, opened)
  }
  return {
    state: { phase: 'window_open', turn, grantsIssued: state.grantsIssued },
    effects: opened,
  }
}

function onRequest(
  state: ArbiterState,
  input: Extract<ArbiterInput, { kind: 'request' }>,
  config: TurnArbiterConfig,
): ArbiterResult {
  const turn = state.turn
  if (state.phase !== 'window_open' || turn === undefined) return unchanged(state)

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
  const turn = state.turn
  if (state.phase !== 'window_open' || turn === undefined) return unchanged(state)
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

function revoke(state: ArbiterState, reason: RevocationReason, cancel: boolean): ArbiterResult {
  const grant = state.grant
  if (grant === undefined) return unchanged(state)

  const effects: ArbiterEffect[] = [emit('turn.revoked', { grantId: grant.grantId, reason })]
  if (cancel) {
    effects.push({ kind: 'cancel_generation', grantId: grant.grantId, reason })
  }
  return { state: idleAfter(state), effects }
}

function onTick(
  state: ArbiterState,
  input: Extract<ArbiterInput, { kind: 'tick' }>,
  config: TurnArbiterConfig,
): ArbiterResult {
  if (state.phase === 'grant_active') {
    if (state.grant !== undefined && input.nowMs >= state.grant.expiresAtMs) {
      // D1 revokes and returns to idle. The bounded replacement belongs to the
      // D2 recovery matrix and must not be simulated here.
      return revoke(state, 'timeout', true)
    }
    return unchanged(state)
  }

  if (state.phase === 'window_open') {
    const turn = state.turn
    if (turn !== undefined && input.nowMs >= turn.windowEndsAtMs) {
      return decide(state, turn, input.nowMs, config)
    }
  }

  return unchanged(state)
}

function onResponseEnded(
  state: ArbiterState,
  input: Extract<ArbiterInput, { kind: 'response_ended' }>,
): ArbiterResult {
  const grant = state.grant
  if (state.phase !== 'grant_active' || grant === undefined) return unchanged(state)
  if (grant.grantId !== input.grantId) return unchanged(state)

  if (input.outcome === 'completed') return revoke(state, 'completed', false)
  return revoke(state, 'cancelled', true)
}

function onClose(state: ArbiterState): ArbiterResult {
  if (state.phase === 'ended') return unchanged(state)

  const effects: ArbiterEffect[] = []
  if (state.grant !== undefined) {
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
  switch (input.kind) {
    case 'user_committed':
      return onUserCommitted(state, input, config)
    case 'request':
      return onRequest(state, input, config)
    case 'declined':
      return onDeclined(state, input, config)
    case 'tick':
      return onTick(state, input, config)
    case 'response_ended':
      return onResponseEnded(state, input)
    case 'close':
      return onClose(state)
    default:
      return unchanged(state)
  }
}
