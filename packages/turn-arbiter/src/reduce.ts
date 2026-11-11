import { rankTurnRequests } from '@rp/routing-policy'
import type {
  EventPayloadFor,
  PersonaId,
  RevocationReason,
  SessionEventName,
  TurnGrant,
} from '@rp/session-core'
import type { TurnArbiterConfig } from './config.js'
import { parseArbiterInput } from './input.js'
import type {
  ActiveGrant,
  ActiveTurn,
  ArbiterCounters,
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
 * persona, ranking with the M3a comparator, one grant, expiry and close. D2
 * adds partial sequencing, the bounded interject opportunity, atomic
 * revoke-then-grant, the recovery matrix and the streak cap.
 *
 * Invalid and late inputs are dropped, not thrown: the reducer must stay total
 * so a fuzz run and a misbehaving transport cannot crash a live session.
 * `parseArbiterInput` validates every field at the boundary; a handler only
 * ever sees a well-typed input.
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

function emit<Name extends SessionEventName>(
  type: Name,
  payload: EventPayloadFor<Name>,
): EmitEventEffect {
  return { kind: 'emit_event', type, payload } as EmitEventEffect
}

function unchanged(state: ArbiterState): ArbiterResult {
  return { state, effects: [] }
}

function idleAfter(counters: ArbiterCounters): ArbiterState {
  return { phase: 'idle', counters }
}

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

/**
 * Most recent successful interjection by this persona, or negative infinity
 * when the persona never interjected. Records are appended in time order, so
 * the last match is the most recent one.
 */
function lastInterjectionAt(counters: ArbiterCounters, personaId: PersonaId): number {
  let last = Number.NEGATIVE_INFINITY
  for (const record of counters.interjections) {
    if (record.personaId === personaId) last = record.atMs
  }
  return last
}

function isInterjectCooldown(
  counters: ArbiterCounters,
  personaId: PersonaId,
  nowMs: number,
  cooldownMs: number,
): boolean {
  return nowMs < lastInterjectionAt(counters, personaId) + cooldownMs
}

interface GrantOptions {
  /** A replacement or interjection speaks without a new user utterance. */
  readonly agentOnly: boolean
  /** Replacements already consumed by this grant. */
  readonly replacementAttempts: number
}

/**
 * Issue the one current grant and its `start_generation` effect.
 *
 * Everything the grant lifecycle needs is computed here, so a normal grant, a
 * replacement and an interjection cannot disagree about expiry or the interject
 * opportunity. The caller owns the revoke effects of whatever grant came
 * before, which keeps the transition atomic: a boundary never sees two grants.
 */
function grantTo(
  turn: ActiveTurn,
  counters: ArbiterCounters,
  personaId: PersonaId,
  nowMs: number,
  config: TurnArbiterConfig,
  options: GrantOptions,
): { state: ArbiterGrantState; effects: ArbiterEffect[] } {
  const grantsIssued = counters.grantsIssued + 1
  const expiresAtMs = nowMs + config.grantTtlMs
  const grant: TurnGrant = {
    turnId: turn.turnId,
    grantId: `grant:${turn.turnId}:${grantsIssued}`,
    personaId,
    expiresAt: new Date(expiresAtMs).toISOString(),
  }
  const interjectableFromMs = nowMs + config.minHoldMs
  const active: ActiveGrant = {
    grantId: grant.grantId,
    personaId,
    expiresAtMs,
    interjectableFromMs,
    interjectWindowEndsAtMs: interjectableFromMs + config.interjectExpiryMs,
    lastPartialSequence: -1,
    interjects: [],
    interjectWindowClosed: false,
    replacementAttempts: options.replacementAttempts,
  }

  return {
    state: {
      phase: 'grant_active',
      grant: active,
      turn,
      counters: {
        ...counters,
        grantsIssued,
        agentOnlyTurns: options.agentOnly ? counters.agentOnlyTurns + 1 : 0,
      },
    },
    effects: [
      emit('turn.granted', { grant }),
      { kind: 'start_generation', grantId: grant.grantId, personaId },
    ],
  }
}

/**
 * Resolve the window into one grant or a learner yield.
 *
 * The comparator is the M3a post-turn ordering, so a live session and an
 * offline replay cannot disagree about who speaks next.
 */
function decide(
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

/**
 * Handle an `interject` request against the active grant.
 *
 * The opportunity is `[interjectableFromMs, interjectWindowEndsAtMs)`. Earlier
 * requests are dropped because the holder has not had its hold; later ones have
 * expired. Accepted requests are collected, not granted: `tick` resolves them
 * with the same comparator, so simultaneous interjects are not decided by
 * arrival order.
 */
function onInterject(
  state: ArbiterState,
  input: Extract<ArbiterInput, { kind: 'request' }>,
  config: TurnArbiterConfig,
): ArbiterResult {
  if (state.phase !== 'grant_active') return unchanged(state)

  const grant = state.grant
  const turn = state.turn
  const request = input.request

  if (request.turnId !== turn.turnId) return unchanged(state)
  if (request.targetGrantId !== grant.grantId) return unchanged(state)
  if (request.personaId === grant.personaId) return unchanged(state)
  if (!turn.eligiblePersonaIds.includes(request.personaId)) return unchanged(state)
  if (turn.declinedBy.includes(request.personaId)) return unchanged(state)
  if (turn.failedBy.includes(request.personaId)) return unchanged(state)
  if (input.nowMs < grant.interjectableFromMs) return unchanged(state)
  if (input.nowMs >= grant.interjectWindowEndsAtMs) return unchanged(state)
  if (
    isInterjectCooldown(state.counters, request.personaId, input.nowMs, config.interjectCooldownMs)
  ) {
    return unchanged(state)
  }
  if (grant.interjects.some((entry) => entry.personaId === request.personaId)) {
    return unchanged(state)
  }

  return {
    state: { ...state, grant: { ...grant, interjects: [...grant.interjects, request] } },
    effects: [emit('persona.requested_turn', { request })],
  }
}

function onRequest(
  state: ArbiterState,
  input: Extract<ArbiterInput, { kind: 'request' }>,
  config: TurnArbiterConfig,
): ArbiterResult {
  if (input.request.action === 'interject') return onInterject(state, input, config)
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

/**
 * Record a failed policy call. It is not a decline: a complete window with a
 * failure yields `policy_timeout`, never `all_declined`.
 */
function onPolicyFailed(
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

function onPartial(
  state: ArbiterState,
  input: Extract<ArbiterInput, { kind: 'partial' }>,
): ArbiterResult {
  if (state.phase !== 'grant_active') return unchanged(state)

  const grant = state.grant
  if (input.grantId !== grant.grantId) return unchanged(state)
  if (input.nowMs >= grant.expiresAtMs) return unchanged(state)
  if (input.sequence <= grant.lastPartialSequence) return unchanged(state)

  return {
    state: { ...state, grant: { ...grant, lastPartialSequence: input.sequence } },
    effects: [
      emit('persona.utterance.partial', {
        grantId: grant.grantId,
        text: input.text,
        sequence: input.sequence,
      }),
    ],
  }
}

function revoke(
  state: ArbiterGrantState,
  reason: RevocationReason,
  cancel: boolean,
  counters: ArbiterCounters = state.counters,
): ArbiterResult {
  const effects: ArbiterEffect[] = [emit('turn.revoked', { grantId: state.grant.grantId, reason })]
  if (cancel) {
    effects.push({ kind: 'cancel_generation', grantId: state.grant.grantId, reason })
  }
  return { state: idleAfter(counters), effects }
}

/**
 * Resolve the bounded interject opportunity.
 *
 * No interject leaves the current grant untouched. One winner revokes the
 * current grant and issues the next one in the same step. At the streak cap the
 * agents stop instead, and the learner gets the turn.
 */
function resolveInterjects(
  state: ArbiterGrantState,
  nowMs: number,
  config: TurnArbiterConfig,
): ArbiterResult {
  const winner = rankTurnRequests(state.turn.context, state.grant.interjects, state.turn.seed)[0]

  if (winner === undefined) {
    return {
      state: { ...state, grant: { ...state.grant, interjectWindowClosed: true } },
      effects: [],
    }
  }

  if (state.counters.agentOnlyTurns >= config.streakCap) {
    return {
      state: idleAfter(state.counters),
      effects: [
        emit('turn.revoked', { grantId: state.grant.grantId, reason: 'interrupted' }),
        { kind: 'cancel_generation', grantId: state.grant.grantId, reason: 'interrupted' },
        emit('turn.user_yielded', { reason: 'streak_cap' }),
      ],
    }
  }

  const revoked: ArbiterEffect[] = [
    emit('turn.revoked', {
      grantId: state.grant.grantId,
      reason: 'interrupted',
    }),
    { kind: 'cancel_generation', grantId: state.grant.grantId, reason: 'interrupted' },
  ]

  const granted = grantTo(
    state.turn,
    {
      ...state.counters,
      interjections: [
        ...state.counters.interjections,
        { personaId: winner.personaId, atMs: nowMs },
      ],
    },
    winner.personaId,
    nowMs,
    config,
    { agentOnly: true, replacementAttempts: 0 },
  )

  return { state: granted.state, effects: [...revoked, ...granted.effects] }
}

/**
 * Recover from a grant holder that failed before producing usable output.
 *
 * One bounded replacement: the best persona that already asked to speak, never
 * the failed one, never someone who declined or failed, and never after the
 * holder streamed text. An unreplaceable failure yields `replacement_failed`;
 * repeated failures close the session cleanly instead of spinning through
 * grants.
 */
function onGenerationFailed(
  state: ArbiterGrantState,
  nowMs: number,
  config: TurnArbiterConfig,
): ArbiterResult {
  const counters: ArbiterCounters = {
    ...state.counters,
    consecutiveFailures: state.counters.consecutiveFailures + 1,
  }
  const revoked: ArbiterEffect[] = [
    emit('turn.revoked', { grantId: state.grant.grantId, reason: 'provider_failure' }),
    { kind: 'cancel_generation', grantId: state.grant.grantId, reason: 'provider_failure' },
  ]

  if (counters.consecutiveFailures >= config.maxConsecutiveFailures) {
    return {
      state: { phase: 'ended', counters },
      effects: [...revoked, emit('session.completed', {}), { kind: 'close_session' }],
    }
  }

  // A holder that already streamed text is not silently swapped: the learner
  // has heard part of that response, so the turn is yielded instead.
  const fallback =
    state.grant.lastPartialSequence < 0
      ? rankTurnRequests(
          state.turn.context,
          state.turn.requests.filter(
            (request) =>
              request.personaId !== state.grant.personaId &&
              !state.turn.failedBy.includes(request.personaId),
          ),
          state.turn.seed,
        )[0]
      : undefined

  if (state.grant.replacementAttempts >= config.replacementAttempts || fallback === undefined) {
    return {
      state: idleAfter(counters),
      effects: [...revoked, emit('turn.user_yielded', { reason: 'replacement_failed' })],
    }
  }

  if (counters.agentOnlyTurns >= config.streakCap) {
    return {
      state: idleAfter(counters),
      effects: [...revoked, emit('turn.user_yielded', { reason: 'streak_cap' })],
    }
  }

  const granted = grantTo(
    {
      ...state.turn,
      failedBy: [...state.turn.failedBy, state.grant.personaId],
    },
    counters,
    fallback.personaId,
    nowMs,
    config,
    { agentOnly: true, replacementAttempts: state.grant.replacementAttempts + 1 },
  )
  return { state: granted.state, effects: [...revoked, ...granted.effects] }
}

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

function onResponseEnded(
  state: ArbiterState,
  input: Extract<ArbiterInput, { kind: 'response_ended' }>,
  config: TurnArbiterConfig,
): ArbiterResult {
  if (state.phase !== 'grant_active') return unchanged(state)
  if (state.grant.grantId !== input.grantId) return unchanged(state)

  if (input.outcome === 'completed') {
    return revoke(state, 'completed', false, {
      ...state.counters,
      consecutiveFailures: 0,
    })
  }
  if (input.outcome === 'cancelled') return revoke(state, 'cancelled', true)
  return onGenerationFailed(state, input.nowMs, config)
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
        emit('turn.revoked', { grantId: state.grant.grantId, reason: 'user_barge_in' }),
        { kind: 'cancel_generation', grantId: state.grant.grantId, reason: 'user_barge_in' },
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
  return { state: { phase: 'ended', counters: state.counters }, effects }
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
