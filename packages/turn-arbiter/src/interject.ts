import { rankTurnRequests } from '@rp/routing-policy'
import type { PersonaId } from '@rp/session-core'
import type { TurnArbiterConfig } from './config.js'
import { emit, idleAfter, revokeEffects, unchanged } from './effects.js'
import { grantTo } from './grant.js'
import type {
  ArbiterCounters,
  ArbiterGrantState,
  ArbiterInput,
  ArbiterResult,
  ArbiterState,
} from './types.js'

/**
 * The bounded interject opportunity.
 *
 * The opportunity is `[interjectableFromMs, interjectWindowEndsAtMs)`. Earlier
 * requests are dropped because the holder has not had its hold; later ones have
 * expired. Accepted requests are collected, not granted: `tick` resolves them
 * with the same comparator, so simultaneous interjects are not decided by
 * arrival order.
 */

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

export function onInterject(
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

/**
 * Resolve the bounded interject opportunity.
 *
 * No interject leaves the current grant untouched. One winner revokes the
 * current grant and issues the next one in the same step. At the streak cap the
 * agents stop instead, and the learner gets the turn.
 */
export function resolveInterjects(
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
        ...revokeEffects(state.grant.grantId, 'interrupted'),
        emit('turn.user_yielded', { reason: 'streak_cap' }),
      ],
    }
  }

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

  return {
    state: granted.state,
    effects: [...revokeEffects(state.grant.grantId, 'interrupted'), ...granted.effects],
  }
}
