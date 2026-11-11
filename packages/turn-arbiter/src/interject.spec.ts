import { rankTurnRequests } from '@rp/routing-policy'
import { sessionEventSchema, type PersonaId } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import {
  TEST_CONFIG,
  emitted,
  granted,
  grantedTurn,
  makeCommitted,
  makeInterject,
  makeRequest,
  makeTurnContext,
  openWindow,
  runArbiter,
} from './fixtures.js'
import { INITIAL_ARBITER_STATE } from './reduce.js'
import type { ArbiterState } from './types.js'

function grantIdOf(state: ArbiterState): string {
  return state.phase === 'grant_active' ? state.grant.grantId : 'grant:missing:1'
}

function partial(
  state: ArbiterState,
  sequence: number,
  nowMs: number,
  text = 'Hello',
): ReturnType<typeof runArbiter> {
  return runArbiter(state, {
    kind: 'partial',
    grantId: grantIdOf(state),
    text,
    sequence,
    nowMs,
  })
}

function interject(
  state: ArbiterState,
  personaId: PersonaId,
  nowMs: number,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof runArbiter> {
  const request = { ...makeInterject(personaId, grantIdOf(state)), ...overrides }
  return runArbiter(state, { kind: 'request', request, nowMs })
}

/** Resolve the interject opportunity with a clock tick at its end. */
function resolveAtWindowEnd(state: ArbiterState): ReturnType<typeof runArbiter> {
  return runArbiter(state, { kind: 'tick', nowMs: 1_820 })
}

const THREE_CONTEXT = makeTurnContext({
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

function commitThree(state: ArbiterState, turnId: string, nowMs: number): ArbiterState {
  return runArbiter(
    state,
    makeCommitted({
      turnId,
      nowMs,
      context: { ...THREE_CONTEXT, turnId },
      eligiblePersonaIds: ['manager', 'peer', 'client'],
    }),
  ).state
}

function threePersonaWindow(turnId: string, nowMs: number): ArbiterState {
  return commitThree(INITIAL_ARBITER_STATE, turnId, nowMs)
}

function collectThreeRequests(
  state: ArbiterState,
  turnId: string,
  winner: PersonaId,
  startMs: number,
): ArbiterState {
  let next = state
  const personas = ['peer', 'manager', 'client'] as const
  for (const [index, personaId] of personas.entries()) {
    next = runArbiter(next, {
      kind: 'request',
      request: makeRequest(personaId, { turnId, addressedByUser: personaId === winner }),
      nowMs: startMs + index * 10,
    }).state
  }
  return next
}

/** A turn where `peer` asks first and `manager` declines, so `peer` holds it. */
function peerGrantAfterDecline(): ArbiterState {
  const window = openWindow()
  const asked = runArbiter(
    window,
    { kind: 'request', request: makeRequest('peer', { addressedByUser: true }), nowMs: 10 },
    TEST_CONFIG,
  ).state
  return runArbiter(
    asked,
    { kind: 'declined', turnId: 'turn-1', personaId: 'manager', nowMs: 20 },
    TEST_CONFIG,
  ).state
}

/** A turn where `peer` asks first and `manager`'s policy fails. */
function peerGrantAfterPolicyFailure(): ArbiterState {
  const asked = runArbiter(openWindow(), {
    kind: 'request',
    request: makeRequest('peer', { addressedByUser: true }),
    nowMs: 10,
  }).state
  return runArbiter(asked, {
    kind: 'policy_failed',
    turnId: 'turn-1',
    personaId: 'manager',
    cause: 'error',
    nowMs: 20,
  }).state
}

describe('turn arbiter partials', () => {
  it('accepts increasing sequences and emits the partial event', () => {
    const state = grantedTurn()
    const first = partial(state, 0, 30, 'Hel')

    expect(first.effects).toEqual([
      emitted('persona.utterance.partial', {
        grantId: state.grant.grantId,
        text: 'Hel',
        sequence: 0,
      }),
    ])
    expect(granted(first.state).grant.lastPartialSequence).toBe(0)

    const second = partial(first.state, 1, 40, 'lo')
    expect(granted(second.state).grant.lastPartialSequence).toBe(1)
    expect(second.effects).toEqual([
      emitted('persona.utterance.partial', {
        grantId: state.grant.grantId,
        text: 'lo',
        sequence: 1,
      }),
    ])
  })

  it('drops a repeated or out-of-order sequence', () => {
    const accepted = partial(grantedTurn(), 3, 30).state

    expect(partial(accepted, 3, 40).effects).toEqual([])
    expect(partial(accepted, 2, 40).effects).toEqual([])
    expect(partial(accepted, 0, 40).effects).toEqual([])
  })

  it('drops a partial for another grant or while no grant is active', () => {
    const state = grantedTurn()

    expect(
      runArbiter(state, {
        kind: 'partial',
        grantId: 'grant:other:1',
        text: 'Hi',
        sequence: 0,
        nowMs: 30,
      }).effects,
    ).toEqual([])
    expect(partial(INITIAL_ARBITER_STATE, 0, 30).effects).toEqual([])
    expect(partial(openWindow(), 0, 30).effects).toEqual([])
  })

  it('does not accept a partial at or after grant expiry', () => {
    const state = grantedTurn()
    expect(partial(state, 0, 5_019).effects).toHaveLength(1)
    expect(partial(state, 0, 5_020).effects).toEqual([])
  })

  it('emits a partial that the session event schema accepts', () => {
    const state = grantedTurn()
    const result = partial(state, 0, 30, 'Bonjour')

    const effect = result.effects[0]
    if (effect?.kind !== 'emit_event' || effect.type !== 'persona.utterance.partial') {
      throw new Error('expected a partial event')
    }
    expect(sessionEventSchema.parse({ type: effect.type, payload: effect.payload })).toBeDefined()
  })
})

describe('turn arbiter interjection', () => {
  it('drops an interject before the hold delay', () => {
    const state = grantedTurn()
    expect(interject(state, 'manager', 819).effects).toEqual([])
  })

  it('accepts an interject exactly at the hold delay', () => {
    const state = grantedTurn()
    const result = interject(state, 'manager', 820)

    expect(result.effects).toEqual([
      emitted('persona.requested_turn', {
        request: makeInterject('manager', state.grant.grantId),
      }),
    ])
    expect(granted(result.state).grant.interjects).toHaveLength(1)
    expect(granted(result.state).grant.interjects[0]?.personaId).toBe('manager')
  })

  it('drops an interject at or after the expiring opportunity', () => {
    const state = grantedTurn()
    expect(interject(state, 'manager', 1_819).effects).toHaveLength(1)
    expect(interject(state, 'manager', 1_820).effects).toEqual([])
  })

  it('drops an interject for another grant or a stale turn', () => {
    const state = grantedTurn()

    expect(interject(state, 'manager', 900, { targetGrantId: 'grant:other:1' }).effects).toEqual([])
    expect(interject(state, 'manager', 900, { turnId: 'turn-other' }).effects).toEqual([])
  })

  it('drops an interject from the holder, an ineligible persona or a non-string persona', () => {
    const state = grantedTurn()

    expect(interject(state, 'peer', 900).effects).toEqual([])
    expect(interject(state, 'client', 900).effects).toEqual([])
    expect(interject(state, 'manager', 900, { personaId: null }).effects).toEqual([])
  })

  it('drops an interject from a persona that declined or failed this turn', () => {
    expect(interject(peerGrantAfterDecline(), 'manager', 900).effects).toEqual([])
    expect(interject(peerGrantAfterPolicyFailure(), 'manager', 900).effects).toEqual([])
  })

  it('drops a second interject from the same persona', () => {
    const accepted = interject(grantedTurn(), 'manager', 820).state
    expect(interject(accepted, 'manager', 900).effects).toEqual([])
  })

  it('does not grant a late interject after the opportunity is resolved', () => {
    const resolved = resolveAtWindowEnd(grantedTurn())
    expect(resolved.state.phase).toBe('grant_active')

    expect(interject(resolved.state, 'manager', 1_830).effects).toEqual([])
  })

  it('revokes and grants in one atomic step with the comparator', () => {
    const state = grantedTurn()
    const accepted = interject(state, 'manager', 820).state
    const resolved = resolveAtWindowEnd(accepted)

    expect(resolved.effects).toEqual([
      emitted('turn.revoked', { grantId: state.grant.grantId, reason: 'interrupted' }),
      { kind: 'cancel_generation', grantId: state.grant.grantId, reason: 'interrupted' },
      emitted('turn.granted', {
        grant: {
          turnId: 'turn-1',
          grantId: 'grant:turn-1:2',
          personaId: 'manager',
          expiresAt: '1970-01-01T00:00:06.820Z',
        },
      }),
      { kind: 'start_generation', grantId: 'grant:turn-1:2', personaId: 'manager' },
    ])
    expect(granted(resolved.state).grant.grantId).toBe('grant:turn-1:2')
    expect(granted(resolved.state).counters.grantsIssued).toBe(2)
    expect(granted(resolved.state).counters.agentOnlyTurns).toBe(1)
    expect(granted(resolved.state).counters.interjections).toEqual([
      { personaId: 'manager', atMs: 1_820 },
    ])
  })

  it('ranks simultaneous interjects with the same comparator', () => {
    const grant = granted(
      collectThreeRequests(threePersonaWindow('turn-1', 0), 'turn-1', 'peer', 10),
    )
    const withManager = interject(grant, 'manager', 900).state
    const withClient = interject(withManager, 'client', 910).state
    expect(granted(withClient).grant.interjects.map((entry) => entry.personaId)).toEqual([
      'manager',
      'client',
    ])

    const resolved = runArbiter(withClient, { kind: 'tick', nowMs: 1_830 })
    const expected = rankTurnRequests(
      THREE_CONTEXT,
      [makeInterject('manager', grant.grant.grantId), makeInterject('client', grant.grant.grantId)],
      7,
    )[0]?.personaId
    expect(expected).toBeDefined()
    expect(granted(resolved.state).grant.personaId).toBe(expected)
    expect(granted(resolved.state).counters.grantsIssued).toBe(2)
  })

  it('applies the interject cooldown only to the persona that interjected', () => {
    let state = collectThreeRequests(threePersonaWindow('turn-1', 0), 'turn-1', 'peer', 10)
    state = interject(state, 'manager', 900).state
    state = runArbiter(state, { kind: 'tick', nowMs: 1_830 }).state
    const managerGrant = granted(state)
    expect(managerGrant.grant.personaId).toBe('manager')

    state = runArbiter(managerGrant, {
      kind: 'response_ended',
      grantId: managerGrant.grant.grantId,
      outcome: 'completed',
      nowMs: 1_900,
    }).state
    state = collectThreeRequests(commitThree(state, 'turn-2', 1_900), 'turn-2', 'peer', 1_910)
    const peerGrant = granted(state)
    expect(peerGrant.grant.personaId).toBe('peer')

    // The manager interjected at 1830 and is cooling down until 4830.
    const blocked = runArbiter(peerGrant, {
      kind: 'request',
      request: makeInterject('manager', peerGrant.grant.grantId, { turnId: 'turn-2' }),
      nowMs: 2_800,
    })
    expect(blocked.effects).toEqual([])

    // The client never interjected, so the manager's cooldown must not apply.
    const allowed = runArbiter(peerGrant, {
      kind: 'request',
      request: makeInterject('client', peerGrant.grant.grantId, { turnId: 'turn-2' }),
      nowMs: 2_800,
    })
    expect(allowed.effects).toHaveLength(1)
  })

  it('enforces the per-persona interject cooldown', () => {
    const cooldownConfig = { ...TEST_CONFIG, interjectCooldownMs: 1_000 }
    let state: ArbiterState = grantedTurn(cooldownConfig, 'peer')
    state = interject(state, 'manager', 820).state
    state = runArbiter(state, { kind: 'tick', nowMs: 1_820 }, cooldownConfig).state
    const managerGrant = granted(state)
    expect(managerGrant.grant.personaId).toBe('manager')

    const completed = runArbiter(
      managerGrant,
      {
        kind: 'response_ended',
        grantId: managerGrant.grant.grantId,
        outcome: 'completed',
        nowMs: 1_900,
      },
      cooldownConfig,
    ).state
    const nextTurn = runArbiter(
      completed,
      makeCommitted({
        turnId: 'turn-2',
        nowMs: 1_900,
        context: makeTurnContext({ turnId: 'turn-2' }),
      }),
      cooldownConfig,
    ).state
    const peerAsked = runArbiter(
      nextTurn,
      {
        kind: 'request',
        request: makeRequest('peer', { turnId: 'turn-2', addressedByUser: true }),
        nowMs: 1_910,
      },
      cooldownConfig,
    ).state
    const peerGrant = granted(
      runArbiter(
        peerAsked,
        { kind: 'request', request: makeRequest('manager', { turnId: 'turn-2' }), nowMs: 1_920 },
        cooldownConfig,
      ).state,
    )
    expect(peerGrant.grant.personaId).toBe('peer')

    const before = runArbiter(
      peerGrant,
      {
        kind: 'request',
        request: makeInterject('manager', peerGrant.grant.grantId, { turnId: 'turn-2' }),
        nowMs: 2_819,
      },
      cooldownConfig,
    )
    expect(before.effects).toEqual([])

    const atBoundary = runArbiter(
      peerGrant,
      {
        kind: 'request',
        request: makeInterject('manager', peerGrant.grant.grantId, { turnId: 'turn-2' }),
        nowMs: 2_820,
      },
      cooldownConfig,
    )
    expect(atBoundary.effects).toHaveLength(1)
  })
})

describe('turn arbiter user barge-in', () => {
  it('revokes the active grant without a model call', () => {
    const state = grantedTurn()
    const { grantId } = state.grant

    const result = runArbiter(state, { kind: 'user_barge_in', nowMs: 30 })

    expect(result.effects).toEqual([
      emitted('user.barge_in', { targetGrantId: grantId }),
      emitted('turn.revoked', { grantId, reason: 'user_barge_in' }),
      { kind: 'cancel_generation', grantId, reason: 'user_barge_in' },
    ])
    expect(result.state.phase).toBe('idle')
  })

  it('discards an open window', () => {
    const result = runArbiter(openWindow(), { kind: 'user_barge_in', nowMs: 10 })
    expect(result.effects).toEqual([emitted('user.barge_in', {})])
    expect(result.state.phase).toBe('idle')
  })

  it('is a no-op while idle or ended', () => {
    expect(runArbiter(INITIAL_ARBITER_STATE, { kind: 'user_barge_in', nowMs: 20 })).toEqual({
      state: INITIAL_ARBITER_STATE,
      effects: [],
    })

    const closed = runArbiter(INITIAL_ARBITER_STATE, { kind: 'close', nowMs: 10 })
    expect(runArbiter(closed.state, { kind: 'user_barge_in', nowMs: 20 })).toEqual({
      state: closed.state,
      effects: [],
    })
  })

  it('drops late partials and responses for a revoked grant', () => {
    const state = grantedTurn()
    const barged = runArbiter(state, { kind: 'user_barge_in', nowMs: 30 }).state

    expect(partial(barged, 0, 40).effects).toEqual([])
    expect(
      runArbiter(barged, {
        kind: 'response_ended',
        grantId: state.grant.grantId,
        outcome: 'completed',
        nowMs: 40,
      }).effects,
    ).toEqual([])
  })
})
