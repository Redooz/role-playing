import { rankTurnRequests } from '@rp/routing-policy'
import type { TurnArbiterConfig } from './config.js'
import { emit, idleAfter, unchanged } from './effects.js'
import { grantTo } from './grant.js'
import type {
  ActiveTurn,
  ArbiterEffect,
  ArbiterInput,
  ArbiterResult,
  ArbiterState,
  ArbiterWindowState,
} from './types.js'

/**
 * The request window: a committed user utterance opens it, eligible personas
 * answer, and a complete window resolves into one grant or a learner yield.
 *
 * The comparator is the M3a post-turn ordering, so a live session and an
 * offline replay cannot disagree about who speaks next.
 */

function hasResponded(turn: ActiveTurn, personaId: string): boolean {
  return (
    turn.declinedBy.includes(personaId) ||
    turn.failedBy.includes(personaId) ||
    turn.requests.some((request) => request.personaId === personaId)
  )
}

function isWindowComplete(turn: ActiveTurn): boolean {
  return turn.eligiblePersonaIds.every((personaId) => hasResponded(turn, personaId))
}

/**
 * Why a complete window produced no winner. A persona whose policy timed out
 * or errored never declined, so its silence must not be reported as a no.
 */
function noWinnerReason(turn: ActiveTurn): 'all_declined' | 'policy_timeout' {
  return turn.failedBy.length > 0 ? 'policy_timeout' : 'all_declined'
}

/** Resolve the window into one grant or a learner yield. */
export function decide(
  state: ArbiterWindowState,
  nowMs: number,
  config: TurnArbiterConfig,
  noWinner: 'all_declined' | 'policy_timeout',
): ArbiterResult {
  const winner = rankTurnRequests(state.turn.context, state.turn.requests, state.turn.seed)[0]
  if (winner === undefined) {
    return {
      state: idleAfter(state.counters),
      effects: [emit('turn.user_yielded', { reason: noWinner })],
    }
  }
  return grantTo(state.turn, state.counters, winner.personaId, nowMs, config, {
    agentOnly: false,
    replacementAttempts: 0,
  })
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
  const decided = decide({ ...state, turn }, nowMs, config, noWinnerReason(turn))
  return { state: decided.state, effects: [...effects, ...decided.effects] }
}

export function onUserCommitted(
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
    failedBy: [],
  }
  const window: ArbiterWindowState = {
    phase: 'window_open',
    turn,
    // A new user utterance breaks any agent-only streak.
    counters: { ...state.counters, agentOnlyTurns: 0 },
  }
  const opened: ArbiterEffect[] = [emit('turn.opened', { turnId: input.turnId })]

  // `closeWindowIfComplete` also covers a turn with no eligible persona: the
  // empty window is complete at once and yields to the learner.
  return closeWindowIfComplete(window, turn, input.nowMs, config, opened)
}

/** A `speak` request from an eligible persona during the open window. */
export function onRequest(
  state: ArbiterState,
  input: Extract<ArbiterInput, { kind: 'request' }>,
  config: TurnArbiterConfig,
): ArbiterResult {
  if (state.phase !== 'window_open') return unchanged(state)

  const turn = state.turn
  const request = input.request
  if (request.turnId !== turn.turnId) return unchanged(state)
  if (input.nowMs >= turn.windowEndsAtMs) return unchanged(state)
  if (!turn.eligiblePersonaIds.includes(request.personaId)) return unchanged(state)
  if (hasResponded(turn, request.personaId)) return unchanged(state)

  const nextTurn: ActiveTurn = { ...turn, requests: [...turn.requests, request] }
  const effects: ArbiterEffect[] = [emit('persona.requested_turn', { request })]
  return closeWindowIfComplete(state, nextTurn, input.nowMs, config, effects)
}

export function onDeclined(
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

/**
 * Record a failed policy call. It is not a decline: a complete window with a
 * failure yields `policy_timeout`, never `all_declined`.
 */
export function onPolicyFailed(
  state: ArbiterState,
  input: Extract<ArbiterInput, { kind: 'policy_failed' }>,
  config: TurnArbiterConfig,
): ArbiterResult {
  if (state.phase !== 'window_open') return unchanged(state)

  const turn = state.turn
  if (input.turnId !== turn.turnId) return unchanged(state)
  if (input.nowMs >= turn.windowEndsAtMs) return unchanged(state)
  if (!turn.eligiblePersonaIds.includes(input.personaId)) return unchanged(state)
  if (hasResponded(turn, input.personaId)) return unchanged(state)

  const nextTurn: ActiveTurn = { ...turn, failedBy: [...turn.failedBy, input.personaId] }
  return closeWindowIfComplete(state, nextTurn, input.nowMs, config, [])
}
