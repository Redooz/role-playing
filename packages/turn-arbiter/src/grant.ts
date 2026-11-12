import type { PersonaId, TurnGrant } from '@rp/session-core'
import type { TurnArbiterConfig } from './config.js'
import { emit, unchanged } from './effects.js'
import type {
  ActiveGrant,
  ActiveTurn,
  ArbiterCounters,
  ArbiterEffect,
  ArbiterGrantState,
  ArbiterInput,
  ArbiterResult,
  ArbiterState,
} from './types.js'

/**
 * Grant issuance and the streamed fragments of the active grant.
 *
 * `grantTo` is the only place a grant is created, so a normal grant, a
 * replacement and an interjection cannot disagree about expiry or the bounded
 * interject opportunity. The caller owns the revoke effects of whatever grant
 * came before, which keeps the transition atomic: a boundary never sees two
 * grants.
 */

interface GrantOptions {
  /** A replacement or interjection speaks without a new user utterance. */
  readonly agentOnly: boolean
  /** Replacements already consumed by this grant. */
  readonly replacementAttempts: number
}

export function grantTo(
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

export function onPartial(
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
