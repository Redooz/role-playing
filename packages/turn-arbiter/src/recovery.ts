import { rankTurnRequests } from '@rp/routing-policy'
import type { TurnArbiterConfig } from './config.js'
import { emit, idleAfter, revoke, revokeEffects, unchanged } from './effects.js'
import { grantTo } from './grant.js'
import type {
  ArbiterCounters,
  ArbiterEffect,
  ArbiterGrantState,
  ArbiterInput,
  ArbiterResult,
  ArbiterState,
} from './types.js'

/**
 * Recovery from a grant holder that failed before producing usable output.
 *
 * One bounded replacement: the best persona that already asked to speak, never
 * the failed one, never someone who declined or failed, and never after the
 * holder streamed text. An unreplaceable failure yields `replacement_failed`;
 * repeated failures close the session cleanly instead of spinning through
 * grants.
 */

export function onGenerationFailed(
  state: ArbiterGrantState,
  nowMs: number,
  config: TurnArbiterConfig,
): ArbiterResult {
  const counters: ArbiterCounters = {
    ...state.counters,
    consecutiveFailures: state.counters.consecutiveFailures + 1,
  }
  const revoked: ArbiterEffect[] = revokeEffects(state.grant.grantId, 'provider_failure')

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

export function onResponseEnded(
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
