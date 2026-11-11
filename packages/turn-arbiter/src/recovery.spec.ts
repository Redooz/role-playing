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

/** A turn where `peer` asks first and `manager` declines, so `peer` holds it. */
function peerGrantAfterDecline(): ArbiterState {
  const asked = runArbiter(openWindow(), {
    kind: 'request',
    request: makeRequest('peer', { addressedByUser: true }),
    nowMs: 10,
  }).state
  return runArbiter(asked, { kind: 'declined', turnId: 'turn-1', personaId: 'manager', nowMs: 20 })
    .state
}

function failGrant(state: ArbiterState, nowMs: number, config = TEST_CONFIG) {
  const grant = granted(state)
  return runArbiter(
    grant,
    {
      kind: 'response_ended',
      grantId: grant.grant.grantId,
      outcome: 'failed',
      nowMs,
    },
    config,
  )
}

function completeGrant(state: ArbiterState, nowMs: number) {
  const grant = granted(state)
  return runArbiter(grant, {
    kind: 'response_ended',
    grantId: grant.grant.grantId,
    outcome: 'completed',
    nowMs,
  })
}

const THREE_PERSONA_CONTEXT = makeTurnContext({
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

function threePersonaGrant(winner = 'peer'): ArbiterState {
  const window = runArbiter(
    INITIAL_ARBITER_STATE,
    makeCommitted({
      context: THREE_PERSONA_CONTEXT,
      eligiblePersonaIds: ['manager', 'peer', 'client'],
    }),
  ).state
  const requests = ['peer', 'manager', 'client'].map((personaId) =>
    makeRequest(personaId, {
      addressedByUser: personaId === winner,
    }),
  )
  let state: ArbiterState = window
  for (const [index, request] of requests.entries()) {
    state = runArbiter(state, { kind: 'request', request, nowMs: 10 + index * 10 }).state
  }
  return state
}

describe('turn arbiter policy failures', () => {
  it('yields a policy timeout when every persona fails', () => {
    const first = runArbiter(openWindow(), {
      kind: 'policy_failed',
      turnId: 'turn-1',
      personaId: 'peer',
      cause: 'timeout',
      nowMs: 10,
    })
    expect(first.effects).toEqual([])
    expect(first.state.phase).toBe('window_open')

    const second = runArbiter(first.state, {
      kind: 'policy_failed',
      turnId: 'turn-1',
      personaId: 'manager',
      cause: 'error',
      nowMs: 20,
    })
    expect(second.effects).toEqual([emitted('turn.user_yielded', { reason: 'policy_timeout' })])
    expect(second.state.phase).toBe('idle')
  })

  it('reports a decline plus a failure as a policy timeout, never all_declined', () => {
    const declined = runArbiter(openWindow(), {
      kind: 'declined',
      turnId: 'turn-1',
      personaId: 'peer',
      nowMs: 10,
    }).state

    const failed = runArbiter(declined, {
      kind: 'policy_failed',
      turnId: 'turn-1',
      personaId: 'manager',
      cause: 'error',
      nowMs: 20,
    })
    expect(failed.effects).toEqual([emitted('turn.user_yielded', { reason: 'policy_timeout' })])
  })

  it('grants the persona that asked when another policy failed', () => {
    const asked = runArbiter(openWindow(), {
      kind: 'request',
      request: makeRequest('manager', { addressedByUser: true }),
      nowMs: 10,
    }).state

    const failed = runArbiter(asked, {
      kind: 'policy_failed',
      turnId: 'turn-1',
      personaId: 'peer',
      cause: 'timeout',
      nowMs: 20,
    })
    expect(granted(failed.state).grant.personaId).toBe('manager')
    expect(failed.effects).toHaveLength(2)
  })

  it('drops a duplicate, unknown or out-of-phase policy failure without recording it', () => {
    const state = runArbiter(openWindow(), {
      kind: 'policy_failed',
      turnId: 'turn-1',
      personaId: 'peer',
      cause: 'timeout',
      nowMs: 10,
    }).state

    expect(
      runArbiter(state, {
        kind: 'policy_failed',
        turnId: 'turn-1',
        personaId: 'peer',
        cause: 'error',
        nowMs: 20,
      }),
    ).toEqual({ state, effects: [] })
    expect(
      runArbiter(state, {
        kind: 'policy_failed',
        turnId: 'turn-1',
        personaId: 'client',
        cause: 'error',
        nowMs: 20,
      }),
    ).toEqual({ state, effects: [] })
    expect(
      runArbiter(INITIAL_ARBITER_STATE, {
        kind: 'policy_failed',
        turnId: 'turn-1',
        personaId: 'peer',
        cause: 'error',
        nowMs: 20,
      }),
    ).toEqual({ state: INITIAL_ARBITER_STATE, effects: [] })

    const grantedState = grantedTurn()
    expect(
      runArbiter(grantedState, {
        kind: 'policy_failed',
        turnId: 'turn-1',
        personaId: 'manager',
        cause: 'error',
        nowMs: 20,
      }),
    ).toEqual({ state: grantedState, effects: [] })
  })

  it('drops a failure from a previous turn instead of contaminating the next window', () => {
    const peerDeclined = runArbiter(openWindow(), {
      kind: 'declined',
      turnId: 'turn-1',
      personaId: 'peer',
      nowMs: 10,
    }).state
    const closed = runArbiter(peerDeclined, {
      kind: 'declined',
      turnId: 'turn-1',
      personaId: 'manager',
      nowMs: 20,
    })
    expect(closed.effects).toEqual([
      emitted('persona.declined', { turnId: 'turn-1', personaId: 'manager' }),
      emitted('turn.user_yielded', { reason: 'all_declined' }),
    ])

    const nextWindow = runArbiter(
      closed.state,
      makeCommitted({
        turnId: 'turn-2',
        nowMs: 30,
        context: makeTurnContext({ turnId: 'turn-2' }),
      }),
    ).state

    const stale = runArbiter(nextWindow, {
      kind: 'policy_failed',
      turnId: 'turn-1',
      personaId: 'peer',
      cause: 'timeout',
      nowMs: 40,
    })
    expect(stale).toEqual({ state: nextWindow, effects: [] })

    const peerDeclinedAgain = runArbiter(stale.state, {
      kind: 'declined',
      turnId: 'turn-2',
      personaId: 'peer',
      nowMs: 50,
    }).state
    const managerDeclined = runArbiter(peerDeclinedAgain, {
      kind: 'declined',
      turnId: 'turn-2',
      personaId: 'manager',
      nowMs: 60,
    })
    expect(managerDeclined.effects).toEqual([
      emitted('persona.declined', { turnId: 'turn-2', personaId: 'manager' }),
      emitted('turn.user_yielded', { reason: 'all_declined' }),
    ])
  })

  it('drops a failure at or after the window deadline', () => {
    const state = runArbiter(openWindow(), {
      kind: 'policy_failed',
      turnId: 'turn-1',
      personaId: 'peer',
      cause: 'timeout',
      nowMs: 10,
    }).state

    expect(
      runArbiter(state, {
        kind: 'policy_failed',
        turnId: 'turn-1',
        personaId: 'manager',
        cause: 'error',
        nowMs: 1_000,
      }),
    ).toEqual({ state, effects: [] })

    const atBoundary = runArbiter(state, {
      kind: 'policy_failed',
      turnId: 'turn-1',
      personaId: 'manager',
      cause: 'error',
      nowMs: 999,
    })
    expect(atBoundary.state.phase).toBe('idle')
    expect(atBoundary.effects).toEqual([emitted('turn.user_yielded', { reason: 'policy_timeout' })])
  })
})

describe('turn arbiter bounded replacement', () => {
  it('replaces a failed holder with the best persona that already asked', () => {
    const state = grantedTurn(TEST_CONFIG, 'peer')
    expect(state.grant.personaId).toBe('peer')

    const result = failGrant(state, 900)

    expect(result.effects).toEqual([
      emitted('turn.revoked', { grantId: 'grant:turn-1:1', reason: 'provider_failure' }),
      { kind: 'cancel_generation', grantId: 'grant:turn-1:1', reason: 'provider_failure' },
      emitted('turn.granted', {
        grant: {
          turnId: 'turn-1',
          grantId: 'grant:turn-1:2',
          personaId: 'manager',
          expiresAt: '1970-01-01T00:00:05.900Z',
        },
      }),
      { kind: 'start_generation', grantId: 'grant:turn-1:2', personaId: 'manager' },
    ])
    expect(granted(result.state).grant.personaId).toBe('manager')
    expect(granted(result.state).grant.replacementAttempts).toBe(1)
    expect(granted(result.state).counters.agentOnlyTurns).toBe(1)
    expect(granted(result.state).counters.consecutiveFailures).toBe(1)
  })

  it('yields replacement_failed when nobody else asked', () => {
    const state = peerGrantAfterDecline()
    const result = failGrant(state, 900)

    expect(result.effects).toEqual([
      emitted('turn.revoked', { grantId: 'grant:turn-1:1', reason: 'provider_failure' }),
      { kind: 'cancel_generation', grantId: 'grant:turn-1:1', reason: 'provider_failure' },
      emitted('turn.user_yielded', { reason: 'replacement_failed' }),
    ])
    expect(result.state.phase).toBe('idle')
    expect(result.state.counters.consecutiveFailures).toBe(1)
    expect(result.state.counters.agentOnlyTurns).toBe(0)
  })

  it('does not replace after partial output', () => {
    const state = grantedTurn(TEST_CONFIG, 'peer')
    const spoken = runArbiter(state, {
      kind: 'partial',
      grantId: state.grant.grantId,
      text: 'I think',
      sequence: 0,
      nowMs: 30,
    }).state

    const result = failGrant(spoken, 900)
    expect(result.effects).toEqual([
      emitted('turn.revoked', { grantId: 'grant:turn-1:1', reason: 'provider_failure' }),
      { kind: 'cancel_generation', grantId: 'grant:turn-1:1', reason: 'provider_failure' },
      emitted('turn.user_yielded', { reason: 'replacement_failed' }),
    ])
    expect(result.state.phase).toBe('idle')
  })

  it('yields replacement_failed when the replacement also fails and the session may continue', () => {
    const config = { ...TEST_CONFIG, maxConsecutiveFailures: 3 }
    const first = failGrant(grantedTurn(config, 'peer'), 900, config)
    const second = failGrant(first.state, 1_500, config)

    expect(second.effects).toEqual([
      emitted('turn.revoked', { grantId: 'grant:turn-1:2', reason: 'provider_failure' }),
      { kind: 'cancel_generation', grantId: 'grant:turn-1:2', reason: 'provider_failure' },
      emitted('turn.user_yielded', { reason: 'replacement_failed' }),
    ])
    expect(second.state.phase).toBe('idle')
    expect(second.state.counters.consecutiveFailures).toBe(2)
  })

  it('bounds the replacement to the configured budget even with another requester', () => {
    const config = {
      ...TEST_CONFIG,
      streakCap: 5,
      replacementAttempts: 1,
      maxConsecutiveFailures: 5,
    }
    const first = failGrant(threePersonaGrant('peer'), 900, config)
    expect(granted(first.state).grant.personaId).toBe('manager')

    const second = failGrant(first.state, 2_000, config)
    expect(second.effects).toEqual([
      emitted('turn.revoked', { grantId: 'grant:turn-1:2', reason: 'provider_failure' }),
      { kind: 'cancel_generation', grantId: 'grant:turn-1:2', reason: 'provider_failure' },
      emitted('turn.user_yielded', { reason: 'replacement_failed' }),
    ])
    expect(second.state.phase).toBe('idle')
  })

  it('closes the session cleanly after the configured consecutive failures', () => {
    const first = failGrant(grantedTurn(TEST_CONFIG, 'peer'), 900)
    const second = failGrant(first.state, 1_500)

    expect(second.effects).toEqual([
      emitted('turn.revoked', { grantId: 'grant:turn-1:2', reason: 'provider_failure' }),
      { kind: 'cancel_generation', grantId: 'grant:turn-1:2', reason: 'provider_failure' },
      emitted('session.completed', {}),
      { kind: 'close_session' },
    ])
    expect(second.state.phase).toBe('ended')
    expect(second.state.counters.consecutiveFailures).toBe(2)

    expect(
      runArbiter(second.state, {
        kind: 'response_ended',
        grantId: 'grant:turn-1:3',
        outcome: 'failed',
        nowMs: 2_000,
      }).effects,
    ).toEqual([])
  })

  it('resets the consecutive failure count after a completed response', () => {
    const first = failGrant(grantedTurn(TEST_CONFIG, 'peer'), 900)
    const completed = completeGrant(first.state, 1_500)

    expect(granted(first.state).grant.personaId).toBe('manager')
    expect(completed.state.phase).toBe('idle')
    expect(completed.state.counters.consecutiveFailures).toBe(0)
  })

  it('keeps the consecutive failure count across a cancellation', () => {
    const first = failGrant(grantedTurn(TEST_CONFIG, 'peer'), 900)
    const grant = granted(first.state)
    const cancelled = runArbiter(first.state, {
      kind: 'response_ended',
      grantId: grant.grant.grantId,
      outcome: 'cancelled',
      nowMs: 1_500,
    })

    expect(cancelled.state.phase).toBe('idle')
    expect(cancelled.state.counters.consecutiveFailures).toBe(1)
  })

  it('ignores a failure for another grant or with no active grant', () => {
    const state = grantedTurn()
    expect(
      runArbiter(state, {
        kind: 'response_ended',
        grantId: 'grant:other:1',
        outcome: 'failed',
        nowMs: 30,
      }).effects,
    ).toEqual([])
    expect(
      runArbiter(openWindow(), {
        kind: 'response_ended',
        grantId: 'grant:turn-1:1',
        outcome: 'failed',
        nowMs: 30,
      }).effects,
    ).toEqual([])
  })
})

describe('turn arbiter streak cap', () => {
  it('stops a third agent-only turn and resets on the next user utterance', () => {
    const config = { ...TEST_CONFIG, streakCap: 2, interjectCooldownMs: 0 }
    let state: ArbiterState = grantedTurn(config, 'peer')

    state = runArbiter(
      state,
      {
        kind: 'request',
        request: makeInterject('manager', granted(state).grant.grantId),
        nowMs: 820,
      },
      config,
    ).state
    state = runArbiter(state, { kind: 'tick', nowMs: 1_820 }, config).state
    expect(granted(state).grant.personaId).toBe('manager')
    expect(granted(state).counters.agentOnlyTurns).toBe(1)

    state = runArbiter(
      state,
      {
        kind: 'request',
        request: makeInterject('peer', granted(state).grant.grantId),
        nowMs: 2_620,
      },
      config,
    ).state
    state = runArbiter(state, { kind: 'tick', nowMs: 3_620 }, config).state
    expect(granted(state).grant.personaId).toBe('peer')
    expect(granted(state).counters.agentOnlyTurns).toBe(2)

    state = runArbiter(
      state,
      {
        kind: 'request',
        request: makeInterject('manager', granted(state).grant.grantId),
        nowMs: 4_420,
      },
      config,
    ).state
    const capped = runArbiter(state, { kind: 'tick', nowMs: 5_420 }, config)

    expect(capped.effects).toEqual([
      emitted('turn.revoked', { grantId: 'grant:turn-1:3', reason: 'interrupted' }),
      { kind: 'cancel_generation', grantId: 'grant:turn-1:3', reason: 'interrupted' },
      emitted('turn.user_yielded', { reason: 'streak_cap' }),
    ])
    expect(capped.state.phase).toBe('idle')
    expect(capped.state.counters.agentOnlyTurns).toBe(2)

    const nextTurn = runArbiter(
      capped.state,
      makeCommitted({
        turnId: 'turn-2',
        nowMs: 5_500,
        context: makeTurnContext({ turnId: 'turn-2' }),
      }),
      config,
    )
    expect(nextTurn.state.phase).toBe('window_open')
    expect(nextTurn.state.counters.agentOnlyTurns).toBe(0)
  })

  it('stops a replacement at the cap even when a fallback exists', () => {
    const config = {
      ...TEST_CONFIG,
      streakCap: 1,
      replacementAttempts: 2,
      maxConsecutiveFailures: 5,
    }
    const first = failGrant(threePersonaGrant('peer'), 900, config)
    expect(granted(first.state).grant.personaId).toBe('manager')
    expect(granted(first.state).counters.agentOnlyTurns).toBe(1)

    const second = failGrant(first.state, 2_000, config)

    expect(second.effects).toEqual([
      emitted('turn.revoked', { grantId: 'grant:turn-1:2', reason: 'provider_failure' }),
      { kind: 'cancel_generation', grantId: 'grant:turn-1:2', reason: 'provider_failure' },
      emitted('turn.user_yielded', { reason: 'streak_cap' }),
    ])
    expect(second.state.phase).toBe('idle')
  })

  it('excludes every failed persona from later replacements', () => {
    const config = {
      ...TEST_CONFIG,
      streakCap: 5,
      replacementAttempts: 2,
      maxConsecutiveFailures: 5,
    }
    const first = failGrant(threePersonaGrant('peer'), 900, config)
    expect(granted(first.state).grant.personaId).toBe('manager')

    const second = failGrant(first.state, 2_000, config)
    expect(granted(second.state).grant.personaId).toBe('client')
  })
})
