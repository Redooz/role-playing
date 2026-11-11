import { createSeededRandom, type SeededRandom } from '@rp/shared'
import { sessionEventSchema, type PersonaId, type TurnRequest } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import { parseTurnArbiterConfig } from './config.js'
import {
  TEST_CONFIG,
  granted,
  grantedTurn,
  makeCommitted,
  makeInterject,
  makeRequest,
  makeTurnContext,
  openWindow,
  runArbiter,
  runRawArbiter,
} from './fixtures.js'
import { INITIAL_ARBITER_STATE } from './reduce.js'
import type { ArbiterEffect, ArbiterInput, ArbiterState } from './types.js'

/**
 * Seeded invariant fuzz and the seven targeted architecture families (M3b-G2).
 *
 * The generator walks the input grammar rather than spraying random JSON: it
 * reads the current phase, so the run reaches windows, grants, partials,
 * interjects, failures, barge-ins and closes. A small share of malformed
 * messages proves the totality contract. Every step asserts the §4.6
 * invariants, and the seven named families are deterministic scenarios.
 */

const FUZZ_CONFIG = parseTurnArbiterConfig({
  requestWindowMs: 100,
  grantTtlMs: 500,
  minHoldMs: 50,
  interjectExpiryMs: 100,
  interjectCooldownMs: 50,
  streakCap: 3,
  replacementAttempts: 1,
  maxConsecutiveFailures: 4,
})

const PERSONAS = ['manager', 'peer', 'client'] as const

const FUZZ_CONTEXT = makeTurnContext({
  personas: [
    ...makeTurnContext().personas,
    {
      id: 'client',
      displayName: 'Dana Whitfield',
      aliases: ['Dana'],
      role: 'client',
      objectives: [{ id: 'signoff', description: 'Sign off the scope.', keywords: ['sign off'] }],
    },
  ],
})

function committedInput(turnId: string, nowMs: number, rng: SeededRandom): ArbiterInput {
  const eligible = rng.int(12) === 0 ? [] : PERSONAS.filter(() => rng.bool(0.85))
  return {
    kind: 'user_committed',
    turnId,
    nowMs,
    seed: rng.int(10_000),
    context: { ...FUZZ_CONTEXT, turnId },
    eligiblePersonaIds: eligible,
  }
}

function requestInput(
  turnId: string,
  grantId: string,
  nowMs: number,
  rng: SeededRandom,
): ArbiterInput {
  const personaId: PersonaId = PERSONAS[rng.int(PERSONAS.length)] as PersonaId
  const base = {
    turnId,
    personaId,
    urgency: rng.next(),
    confidence: rng.next(),
    addressedByUser: rng.bool(0.2),
    objectiveRelevance: rng.next(),
  }
  const request: TurnRequest = rng.bool(0.15)
    ? { ...base, action: 'interject', targetGrantId: grantId }
    : { ...base, action: 'speak' }
  return { kind: 'request', request, nowMs }
}

function garbageInput(nowMs: number): unknown {
  return [
    null,
    42,
    'tick',
    { kind: 'nope' },
    { kind: 'tick' },
    { kind: 'request', request: null, nowMs },
    { kind: 'close', nowMs, extra: true },
  ][nowMs % 7]
}

interface Generated {
  readonly input: unknown
  readonly nowMs: number
  readonly nextTurnSeq: number
}

function generate(
  rng: SeededRandom,
  state: ArbiterState,
  clock: number,
  turnSeq: number,
): Generated {
  const nowMs = clock + rng.int(140)
  if (rng.int(100) < 6) return { input: garbageInput(nowMs), nowMs, nextTurnSeq: turnSeq }

  if (state.phase === 'ended') {
    return { input: { kind: 'tick', nowMs }, nowMs, nextTurnSeq: turnSeq }
  }

  if (state.phase === 'idle') {
    if (rng.bool(0.75)) {
      const turnId = `turn-${turnSeq}`
      return { input: committedInput(turnId, nowMs, rng), nowMs, nextTurnSeq: turnSeq + 1 }
    }
    return { input: { kind: 'tick', nowMs }, nowMs, nextTurnSeq: turnSeq }
  }

  const turnId = state.turn.turnId

  if (state.phase === 'window_open') {
    const roll = rng.int(100)
    if (roll < 55) {
      return {
        input: requestInput(turnId, 'grant:none:0', nowMs, rng),
        nowMs,
        nextTurnSeq: turnSeq,
      }
    }
    if (roll < 70) {
      return {
        input: {
          kind: 'declined',
          turnId,
          personaId: PERSONAS[rng.int(PERSONAS.length)],
          nowMs,
        },
        nowMs,
        nextTurnSeq: turnSeq,
      }
    }
    if (roll < 80) {
      return {
        input: {
          kind: 'policy_failed',
          personaId: PERSONAS[rng.int(PERSONAS.length)],
          cause: rng.bool() ? 'timeout' : 'error',
          nowMs,
        },
        nowMs,
        nextTurnSeq: turnSeq,
      }
    }
    if (roll < 97) return { input: { kind: 'tick', nowMs }, nowMs, nextTurnSeq: turnSeq }
    return { input: { kind: 'user_barge_in', nowMs }, nowMs, nextTurnSeq: turnSeq }
  }

  const grantId = state.grant.grantId
  const roll = rng.int(100)
  if (roll < 40) {
    return {
      input: {
        kind: 'partial',
        grantId,
        text: `part-${roll}`,
        sequence: rng.int(4),
        nowMs,
      },
      nowMs,
      nextTurnSeq: turnSeq,
    }
  }
  if (roll < 60) {
    return { input: requestInput(turnId, grantId, nowMs, rng), nowMs, nextTurnSeq: turnSeq }
  }
  if (roll < 72) {
    return {
      input: { kind: 'response_ended', grantId, outcome: 'completed', nowMs },
      nowMs,
      nextTurnSeq: turnSeq,
    }
  }
  if (roll < 80) {
    return {
      input: { kind: 'response_ended', grantId, outcome: 'cancelled', nowMs },
      nowMs,
      nextTurnSeq: turnSeq,
    }
  }
  if (roll < 86) {
    return {
      input: { kind: 'response_ended', grantId, outcome: 'failed', nowMs },
      nowMs,
      nextTurnSeq: turnSeq,
    }
  }
  if (roll < 94) return { input: { kind: 'tick', nowMs }, nowMs, nextTurnSeq: turnSeq }
  if (roll < 97) {
    return { input: { kind: 'user_barge_in', nowMs }, nowMs, nextTurnSeq: turnSeq }
  }
  return {
    input: { kind: 'close', nowMs },
    nowMs,
    nextTurnSeq: turnSeq,
  }
}

interface InvariantLedger {
  readonly grantIds: Set<string>
  readonly partialSequences: Map<string, number>
}

function assertInvariants(
  before: ArbiterState,
  after: ArbiterState,
  effects: readonly ArbiterEffect[],
  ledger: InvariantLedger,
): void {
  expect(after.counters.grantsIssued).toBeGreaterThanOrEqual(before.counters.grantsIssued)
  expect(after.counters.agentOnlyTurns).toBeGreaterThanOrEqual(0)
  expect(after.counters.consecutiveFailures).toBeGreaterThanOrEqual(0)

  if (after.phase === 'grant_active') {
    expect(after.grant.grantId.startsWith('grant:')).toBe(true)
  } else {
    expect('grant' in after).toBe(false)
  }

  const started = effects.filter((effect) => effect.kind === 'start_generation')
  expect(started.length).toBeLessThanOrEqual(1)
  if (started[0] !== undefined) {
    expect(after.phase).toBe('grant_active')
    if (after.phase === 'grant_active') {
      expect(started[0]).toMatchObject({
        kind: 'start_generation',
        grantId: after.grant.grantId,
        personaId: after.grant.personaId,
      })
    }
  }

  const grantedEvents = effects.filter(
    (effect) => effect.kind === 'emit_event' && effect.type === 'turn.granted',
  )
  expect(grantedEvents.length).toBe(started.length)
  for (const effect of grantedEvents) {
    if (effect.kind !== 'emit_event' || effect.type !== 'turn.granted') continue
    expect(ledger.grantIds.has(effect.payload.grant.grantId)).toBe(false)
    ledger.grantIds.add(effect.payload.grant.grantId)
  }

  for (const [index, effect] of effects.entries()) {
    if (effect.kind === 'emit_event') {
      expect(() =>
        sessionEventSchema.parse({ type: effect.type, payload: effect.payload }),
      ).not.toThrow()
      if (effect.type === 'persona.utterance.partial') {
        const previous = ledger.partialSequences.get(effect.payload.grantId) ?? -1
        expect(effect.payload.sequence).toBeGreaterThan(previous)
        ledger.partialSequences.set(effect.payload.grantId, effect.payload.sequence)
      }
    }

    if (effect.kind === 'cancel_generation') {
      const revokedBefore = effects
        .slice(0, index)
        .some(
          (prior) =>
            prior.kind === 'emit_event' &&
            prior.type === 'turn.revoked' &&
            prior.payload.grantId === effect.grantId,
        )
      expect(revokedBefore).toBe(true)
    }
  }

  if (before.phase === 'ended') {
    expect(after).toEqual(before)
    expect(effects).toEqual([])
  }
}

describe('turn arbiter invariant fuzz', () => {
  it('holds every invariant over 1,000 seeded mixed inputs under 10 s', () => {
    const rng = createSeededRandom(2_026)
    const ledger: InvariantLedger = { grantIds: new Set(), partialSequences: new Map() }
    const startedAt = performance.now()

    let state: ArbiterState = INITIAL_ARBITER_STATE
    let clock = 0
    let turnSeq = 0
    let grantedCount = 0
    let yielded = 0
    let partials = 0

    for (let step = 0; step < 1_000; step += 1) {
      const generated = generate(rng, state, clock, turnSeq)
      clock = generated.nowMs
      turnSeq = generated.nextTurnSeq

      const result = runRawArbiter(state, generated.input, FUZZ_CONFIG)
      assertInvariants(state, result.state, result.effects, ledger)

      for (const effect of result.effects) {
        if (effect.kind !== 'emit_event') continue
        if (effect.type === 'turn.granted') grantedCount += 1
        if (effect.type === 'turn.user_yielded') yielded += 1
        if (effect.type === 'persona.utterance.partial') partials += 1
      }

      state = result.state
    }

    expect(performance.now() - startedAt).toBeLessThan(10_000)
    expect(grantedCount).toBeGreaterThan(2)
    expect(yielded).toBeGreaterThan(0)
    expect(partials).toBeGreaterThan(0)
    expect(ledger.grantIds.size).toBe(grantedCount)
  })
})

describe('turn arbiter targeted families', () => {
  it('grant expiry revokes once and is idempotent', () => {
    const state = grantedTurn()
    const { grantId, expiresAtMs } = state.grant

    const expired = runArbiter(state, { kind: 'tick', nowMs: expiresAtMs })
    expect(expired.state.phase).toBe('idle')
    expect(expired.effects).toHaveLength(2)

    expect(runArbiter(expired.state, { kind: 'tick', nowMs: expiresAtMs + 1 })).toEqual({
      state: expired.state,
      effects: [],
    })
    expect(grantId).toBe('grant:turn-1:1')
  })

  it('provider hang times out the grant without inventing output', () => {
    const state = grantedTurn()
    const first = runArbiter(state, {
      kind: 'partial',
      grantId: state.grant.grantId,
      text: 'Well',
      sequence: 0,
      nowMs: 100,
    })
    expect(granted(first.state).grant.lastPartialSequence).toBe(0)

    const hung = runArbiter(first.state, {
      kind: 'tick',
      nowMs: state.grant.expiresAtMs,
    })
    expect(hung.effects).toEqual([
      {
        kind: 'emit_event',
        type: 'turn.revoked',
        payload: { grantId: state.grant.grantId, reason: 'timeout' },
      },
      { kind: 'cancel_generation', grantId: state.grant.grantId, reason: 'timeout' },
    ])
    expect(hung.state.phase).toBe('idle')
  })

  it('drops a late chunk after revocation', () => {
    const state = grantedTurn()
    const barged = runArbiter(state, { kind: 'user_barge_in', nowMs: 30 }).state

    expect(
      runArbiter(barged, {
        kind: 'partial',
        grantId: state.grant.grantId,
        text: 'late',
        sequence: 1,
        nowMs: 40,
      }).effects,
    ).toEqual([])
    expect(
      runArbiter(barged, {
        kind: 'response_ended',
        grantId: state.grant.grantId,
        outcome: 'completed',
        nowMs: 40,
      }).effects,
    ).toEqual([])
  })

  it('yields all_declined when every persona passes', () => {
    const window = openWindow()
    const first = runArbiter(window, {
      kind: 'declined',
      turnId: 'turn-1',
      personaId: 'peer',
      nowMs: 10,
    }).state
    const second = runArbiter(first, {
      kind: 'declined',
      turnId: 'turn-1',
      personaId: 'manager',
      nowMs: 20,
    })

    expect(second.state.phase).toBe('idle')
    expect(second.effects.at(-1)).toMatchObject({
      kind: 'emit_event',
      type: 'turn.user_yielded',
      payload: { reason: 'all_declined' },
    })
  })

  it('resolves simultaneous interjects into exactly one new grant', () => {
    const window = runArbiter(
      INITIAL_ARBITER_STATE,
      makeCommitted({ context: FUZZ_CONTEXT, eligiblePersonaIds: ['manager', 'peer', 'client'] }),
    ).state
    let state: ArbiterState = window
    for (const [index, personaId] of ['manager', 'peer', 'client'].entries()) {
      state = runArbiter(
        state,
        {
          kind: 'request',
          request: makeRequest(personaId, { addressedByUser: personaId === 'peer' }),
          nowMs: 10 + index * 10,
        },
        TEST_CONFIG,
      ).state
    }
    const grant = granted(state)

    state = runArbiter(
      grant,
      {
        kind: 'request',
        request: makeInterject('manager', grant.grant.grantId),
        nowMs: 830,
      },
      TEST_CONFIG,
    ).state
    state = runArbiter(
      state,
      {
        kind: 'request',
        request: makeInterject('client', grant.grant.grantId),
        nowMs: 840,
      },
      TEST_CONFIG,
    ).state

    const resolved = runArbiter(state, { kind: 'tick', nowMs: 1_830 }, TEST_CONFIG)
    expect(resolved.state.phase).toBe('grant_active')
    expect(granted(resolved.state).counters.grantsIssued).toBe(2)
    expect(resolved.effects.filter((effect) => effect.kind === 'start_generation')).toHaveLength(1)
  })

  it('drops stale messages from a previous session after a reconnect', () => {
    const previous = grantedTurn()
    const oldGrantId = previous.grant.grantId
    const closed = runArbiter(previous, { kind: 'close', nowMs: 30 })

    for (const input of [
      { kind: 'partial', grantId: oldGrantId, text: 'late', sequence: 0, nowMs: 40 },
      { kind: 'response_ended', grantId: oldGrantId, outcome: 'completed', nowMs: 40 },
      { kind: 'declined', turnId: 'turn-1', personaId: 'peer', nowMs: 40 },
      { kind: 'tick', nowMs: 10_000 },
    ] satisfies ArbiterInput[]) {
      expect(runArbiter(closed.state, input)).toEqual({ state: closed.state, effects: [] })
    }

    // A fresh session starts from the initial state, not from the ended one.
    const fresh = runArbiter(INITIAL_ARBITER_STATE, makeCommitted({ turnId: 'turn-9', nowMs: 0 }))
    expect(fresh.state.phase).toBe('window_open')
    expect(fresh.state.counters.grantsIssued).toBe(0)
  })

  it('lets user interruption win over an active grant', () => {
    const state = grantedTurn()
    const result = runArbiter(state, { kind: 'user_barge_in', nowMs: 30 })

    expect(result.state.phase).toBe('idle')
    expect(result.effects.map((effect) => effect.kind)).toEqual([
      'emit_event',
      'emit_event',
      'cancel_generation',
    ])
    expect(result.effects[0]).toMatchObject({ type: 'user.barge_in' })
    expect(result.effects[1]).toMatchObject({
      type: 'turn.revoked',
      payload: { reason: 'user_barge_in' },
    })
  })
})
