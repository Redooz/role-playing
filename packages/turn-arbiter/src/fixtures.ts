import type { RoutingContext } from '@rp/routing-policy'
import type { PersonaId, TurnRequest } from '@rp/session-core'
import { parseTurnArbiterConfig, type TurnArbiterConfig } from './config.js'
import { INITIAL_ARBITER_STATE, reduce } from './reduce.js'
import type {
  ArbiterEffect,
  ArbiterGrantState,
  ArbiterInput,
  ArbiterResult,
  ArbiterState,
  UserCommittedInput,
} from './types.js'

/**
 * Test fixtures and helpers for the arbiter.
 *
 * Excluded from the mutation scope like every `*fixtures.ts`: it wires a real
 * reducer, so a bug here would be a test failure, not a silently survivable
 * mutant. The production config defaults stay the source of truth; the test
 * config only shrinks the window so the cases read clearly.
 */

export const TEST_CONFIG: TurnArbiterConfig = parseTurnArbiterConfig({
  requestWindowMs: 1_000,
  grantTtlMs: 5_000,
  minHoldMs: 800,
  interjectExpiryMs: 1_000,
  interjectCooldownMs: 3_000,
  streakCap: 2,
  replacementAttempts: 1,
  maxConsecutiveFailures: 2,
})

export function makeTurnContext(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    decisionId: 'decision-1',
    turnId: 'turn-1',
    lang: 'en',
    transcript: [{ speaker: { kind: 'user' }, text: 'Sam, can you take the standup?' }],
    personas: [
      {
        id: 'manager',
        displayName: 'Katherine Brooks',
        aliases: ['Katherine', 'Kate'],
        role: 'manager',
        objectives: [
          {
            id: 'deadline',
            description: 'Agree a delivery deadline.',
            keywords: ['deadline', 'delivery date'],
          },
        ],
      },
      {
        id: 'peer',
        displayName: 'Sam Carter',
        aliases: ['Sam'],
        role: 'peer colleague',
        objectives: [
          {
            id: 'handoff',
            description: 'Confirm the handoff before the standup.',
            keywords: ['handoff', 'standup'],
          },
        ],
      },
    ],
    coveredObjectiveIds: [],
    ...overrides,
  }
}

export function makeRequest(
  personaId: PersonaId,
  overrides: Partial<TurnRequest> = {},
): TurnRequest {
  return {
    turnId: 'turn-1',
    personaId,
    action: 'speak',
    urgency: 0.5,
    confidence: 0.5,
    addressedByUser: false,
    objectiveRelevance: 0.5,
    ...overrides,
  }
}

export function makeInterject(
  personaId: PersonaId,
  targetGrantId: string,
  overrides: Partial<TurnRequest> = {},
): TurnRequest {
  return makeRequest(personaId, { action: 'interject', targetGrantId, ...overrides })
}

export function makeCommitted(overrides: Partial<UserCommittedInput> = {}): UserCommittedInput {
  return {
    kind: 'user_committed',
    turnId: 'turn-1',
    nowMs: 0,
    seed: 7,
    context: makeTurnContext(),
    eligiblePersonaIds: ['manager', 'peer'],
    ...overrides,
  }
}

export function runArbiter(
  state: ArbiterState,
  input: ArbiterInput,
  config: TurnArbiterConfig = TEST_CONFIG,
): ArbiterResult {
  return reduce(state, input, config)
}

/** Bypasses the compile-time input type, as a transport or fuzz run would. */
export function runRawArbiter(
  state: ArbiterState,
  input: unknown,
  config: TurnArbiterConfig = TEST_CONFIG,
): ArbiterResult {
  return reduce(state, input as ArbiterInput, config)
}

export function openWindow(
  config: TurnArbiterConfig = TEST_CONFIG,
  overrides: Partial<UserCommittedInput> = {},
): ArbiterState {
  return runArbiter(INITIAL_ARBITER_STATE, makeCommitted(overrides), config).state
}

/** A turn where both personas requested and one holds the grant. */
export function grantedTurn(
  config: TurnArbiterConfig = TEST_CONFIG,
  winner: PersonaId = 'peer',
): ArbiterGrantState {
  const loser: PersonaId = winner === 'peer' ? 'manager' : 'peer'
  const first = runArbiter(
    openWindow(config),
    {
      kind: 'request',
      request: makeRequest(winner, { addressedByUser: true }),
      nowMs: 10,
    },
    config,
  )
  const second = runArbiter(
    first.state,
    { kind: 'request', request: makeRequest(loser), nowMs: 20 },
    config,
  )
  return granted(second.state)
}

export function granted(state: ArbiterState): ArbiterGrantState {
  if (state.phase !== 'grant_active') throw new Error('expected a grant')
  return state
}

export function emitted(type: string, payload: unknown): ArbiterEffect {
  return { kind: 'emit_event', type, payload } as ArbiterEffect
}
