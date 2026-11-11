import { rankTurnRequests } from '@rp/routing-policy'
import { sessionEventSchema, type PersonaId, type TurnRequest } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import {
  emitted,
  granted,
  grantedTurn,
  makeCommitted,
  makeRequest,
  makeTurnContext,
  openWindow,
  runArbiter,
  runRawArbiter,
} from './fixtures.js'
import { MAX_TIME_VALUE_MS } from './input.js'
import { INITIAL_ARBITER_STATE } from './reduce.js'
import type { ArbiterInput, ArbiterResult, ArbiterState, UserCommittedInput } from './types.js'

const EMPTY_COUNTERS = {
  grantsIssued: 0,
  agentOnlyTurns: 0,
  consecutiveFailures: 0,
  interjections: [],
}

function committed(overrides: Partial<UserCommittedInput> = {}): UserCommittedInput {
  return makeCommitted(overrides)
}

function request(personaId: PersonaId, overrides: Partial<TurnRequest> = {}): TurnRequest {
  return makeRequest(personaId, overrides)
}

function run(state: ArbiterState, input: ArbiterInput): ArbiterResult {
  return runArbiter(state, input)
}

function runRaw(state: ArbiterState, input: unknown): ArbiterResult {
  return runRawArbiter(state, input)
}

describe('turn arbiter normal flow', () => {
  it('opens a bounded request window on a committed user utterance', () => {
    const result = run(INITIAL_ARBITER_STATE, committed())

    expect(result.state.phase).toBe('window_open')
    expect(result.state.phase === 'window_open' && result.state.turn.windowEndsAtMs).toBe(1_000)
    expect(result.state.counters).toEqual(EMPTY_COUNTERS)
    expect(result.state.phase === 'window_open' && result.state.turn.declinedBy).toEqual([])
    expect(result.state.phase === 'window_open' && result.state.turn.failedBy).toEqual([])
    expect(result.effects).toEqual([emitted('turn.opened', { turnId: 'turn-1' })])
  })

  it('ignores a committed utterance while a window is open', () => {
    const state = openWindow()
    expect(run(state, committed({ turnId: 'turn-2' }))).toEqual({ state, effects: [] })
  })

  it('drops a committed utterance whose routing context is malformed', () => {
    const malformed = {
      ...makeTurnContext(),
      transcript: [],
    } as unknown as UserCommittedInput['context']

    const result = run(INITIAL_ARBITER_STATE, committed({ context: malformed }))

    expect(result).toEqual({ state: INITIAL_ARBITER_STATE, effects: [] })
  })

  it('never throws on a non-object routing context', () => {
    const malformed = null as unknown as UserCommittedInput['context']

    expect(() => run(INITIAL_ARBITER_STATE, committed({ context: malformed }))).not.toThrow()
    expect(run(INITIAL_ARBITER_STATE, committed({ context: malformed })).effects).toEqual([])
  })

  it('records one request per eligible persona', () => {
    const peer = request('peer')
    const result = run(openWindow(), { kind: 'request', request: peer, nowMs: 10 })

    expect(result.state.phase === 'window_open' && result.state.turn.requests).toEqual([peer])
    expect(result.effects).toEqual([emitted('persona.requested_turn', { request: peer })])
  })

  it('decides as soon as every eligible persona has responded', () => {
    const peer = request('peer')
    const manager = request('manager', { addressedByUser: true })
    const first = run(openWindow(), { kind: 'request', request: peer, nowMs: 10 })
    expect(first.state.phase).toBe('window_open')

    const second = run(first.state, { kind: 'request', request: manager, nowMs: 20 })

    expect(granted(second.state).grant.personaId).toBe('manager')
    expect(granted(second.state).counters).toEqual({
      ...EMPTY_COUNTERS,
      grantsIssued: 1,
    })
    expect(second.effects).toEqual([
      emitted('persona.requested_turn', { request: manager }),
      emitted('turn.granted', {
        grant: {
          turnId: 'turn-1',
          grantId: 'grant:turn-1:1',
          personaId: 'manager',
          expiresAt: '1970-01-01T00:00:05.020Z',
        },
      }),
      { kind: 'start_generation', grantId: 'grant:turn-1:1', personaId: 'manager' },
    ])

    const grantEffect = second.effects[1]
    if (grantEffect?.kind !== 'emit_event' || grantEffect.type !== 'turn.granted') {
      throw new Error('expected turn.granted')
    }
    expect(
      sessionEventSchema.parse({ type: grantEffect.type, payload: grantEffect.payload }),
    ).toBeDefined()
  })

  it('yields to the learner when every persona declines', () => {
    const first = run(openWindow(), {
      kind: 'declined',
      turnId: 'turn-1',
      personaId: 'peer',
      nowMs: 10,
    })
    expect(first.effects).toEqual([
      emitted('persona.declined', { turnId: 'turn-1', personaId: 'peer' }),
    ])
    expect(first.state.phase).toBe('window_open')

    const second = run(first.state, {
      kind: 'declined',
      turnId: 'turn-1',
      personaId: 'manager',
      nowMs: 20,
    })
    expect(second.effects).toEqual([
      emitted('persona.declined', { turnId: 'turn-1', personaId: 'manager' }),
      emitted('turn.user_yielded', { reason: 'all_declined' }),
    ])
    expect(second.state.phase).toBe('idle')
  })

  it('waits for the window to close before deciding', () => {
    const state = run(openWindow(), { kind: 'request', request: request('peer'), nowMs: 10 }).state

    expect(run(state, { kind: 'tick', nowMs: 999 })).toEqual({ state, effects: [] })

    const closed = run(state, { kind: 'tick', nowMs: 1_000 })
    expect(granted(closed.state).grant.personaId).toBe('peer')
  })

  it('yields a policy timeout when the window expires unanswered', () => {
    const closed = run(openWindow(), { kind: 'tick', nowMs: 1_000 })

    expect(closed.effects).toEqual([emitted('turn.user_yielded', { reason: 'policy_timeout' })])
    expect(closed.state.phase).toBe('idle')
  })

  it('does not report a partial decline as all_declined when the window expires', () => {
    const declined = run(openWindow(), {
      kind: 'declined',
      turnId: 'turn-1',
      personaId: 'peer',
      nowMs: 10,
    })
    expect(declined.state.phase).toBe('window_open')

    const expired = run(declined.state, { kind: 'tick', nowMs: 1_000 })

    expect(expired.effects).toEqual([emitted('turn.user_yielded', { reason: 'policy_timeout' })])
    expect(expired.state.phase).toBe('idle')
  })

  it('yields immediately when no persona is eligible', () => {
    const result = run(INITIAL_ARBITER_STATE, committed({ eligiblePersonaIds: [] }))

    expect(result.effects).toEqual([
      emitted('turn.opened', { turnId: 'turn-1' }),
      emitted('turn.user_yielded', { reason: 'all_declined' }),
    ])
    expect(result.state).toEqual({ phase: 'idle', counters: EMPTY_COUNTERS })
  })

  it('drops a request at the exact window boundary', () => {
    const result = run(openWindow(), { kind: 'request', request: request('peer'), nowMs: 1_000 })
    expect(result.effects).toEqual([])
  })

  it('drops late, stale, duplicate, ineligible and interject requests', () => {
    const state = openWindow()
    const accepted = run(state, { kind: 'request', request: request('peer'), nowMs: 10 }).state

    const dropped = [
      run(state, {
        kind: 'request',
        request: request('peer', { turnId: 'turn-other' }),
        nowMs: 10,
      }),
      run(state, { kind: 'request', request: request('client'), nowMs: 10 }),
      run(accepted, { kind: 'request', request: request('peer'), nowMs: 20 }),
      run(state, { kind: 'request', request: request('manager'), nowMs: 1_001 }),
      run(state, {
        kind: 'request',
        request: request('manager', { action: 'interject', targetGrantId: 'grant-1' }),
        nowMs: 10,
      }),
    ]

    for (const result of dropped) expect(result.effects).toEqual([])
  })

  it('drops a request from a persona that already declined', () => {
    const state = run(openWindow(), {
      kind: 'declined',
      turnId: 'turn-1',
      personaId: 'peer',
      nowMs: 10,
    }).state
    expect(run(state, { kind: 'request', request: request('peer'), nowMs: 20 }).effects).toEqual([])
  })

  it('drops a decline from a stale turn', () => {
    const state = openWindow()
    expect(
      run(state, { kind: 'declined', turnId: 'turn-other', personaId: 'peer', nowMs: 10 }).effects,
    ).toEqual([])
  })

  it('drops a decline while a grant is active', () => {
    const state = grantedTurn()
    expect(
      run(state, { kind: 'declined', turnId: 'turn-1', personaId: 'peer', nowMs: 30 }).effects,
    ).toEqual([])
  })

  it('drops a speak request while a grant is active', () => {
    const state = grantedTurn()
    expect(run(state, { kind: 'request', request: request('manager'), nowMs: 30 }).effects).toEqual(
      [],
    )
  })

  it('drops a stale speak request from the grant phase even with an earlier clock', () => {
    const asked = run(openWindow(), {
      kind: 'request',
      request: request('peer'),
      nowMs: 10,
    }).state
    const closed = run(asked, { kind: 'tick', nowMs: 1_000 })
    const state = granted(closed.state)
    expect(state.grant.personaId).toBe('peer')

    expect(run(state, { kind: 'request', request: request('manager'), nowMs: 500 })).toEqual({
      state,
      effects: [],
    })
  })

  it('grants one deterministic speaker when two requests tie', () => {
    const manager = request('manager')
    const peer = request('peer')
    const expected = rankTurnRequests(makeTurnContext(), [manager, peer], 7)[0]?.personaId
    expect(expected).toBeDefined()

    const first = run(openWindow(), { kind: 'request', request: manager, nowMs: 10 })
    const second = run(first.state, { kind: 'request', request: peer, nowMs: 20 })
    expect(granted(second.state).grant.personaId).toBe(expected)

    const replayFirst = run(openWindow(), { kind: 'request', request: manager, nowMs: 10 })
    const replaySecond = run(replayFirst.state, { kind: 'request', request: peer, nowMs: 20 })
    expect(granted(replaySecond.state).grant.grantId).toBe(granted(second.state).grant.grantId)
  })

  it('issues unique grant ids across turns', () => {
    const first = grantedTurn()
    const ended = run(first, {
      kind: 'response_ended',
      grantId: first.grant.grantId,
      outcome: 'completed',
      nowMs: 30,
    })
    const nextTurn = run(
      ended.state,
      committed({ turnId: 'turn-2', nowMs: 40, context: makeTurnContext({ turnId: 'turn-2' }) }),
    ).state
    const asked = run(nextTurn, {
      kind: 'request',
      request: request('manager', { turnId: 'turn-2' }),
      nowMs: 50,
    }).state
    const second = run(asked, {
      kind: 'request',
      request: request('peer', { turnId: 'turn-2' }),
      nowMs: 60,
    })

    expect(granted(second.state).grant.grantId).not.toBe(first.grant.grantId)
    expect(granted(second.state).counters.grantsIssued).toBe(2)
  })
})

describe('turn arbiter grant lifecycle', () => {
  it('revokes an expired grant once and returns to idle', () => {
    const state = grantedTurn()
    const { grantId, expiresAtMs } = state.grant

    const expired = run(state, { kind: 'tick', nowMs: expiresAtMs })
    expect(expired.effects).toEqual([
      emitted('turn.revoked', { grantId, reason: 'timeout' }),
      { kind: 'cancel_generation', grantId, reason: 'timeout' },
    ])
    expect(expired.state.phase).toBe('idle')

    expect(run(expired.state, { kind: 'tick', nowMs: expiresAtMs + 1 })).toEqual({
      state: expired.state,
      effects: [],
    })
  })

  it('leaves an open grant untouched before the interject opportunity ends', () => {
    const state = grantedTurn()
    expect(run(state, { kind: 'tick', nowMs: 1_000 })).toEqual({ state, effects: [] })
  })

  it('closes an interject opportunity with no interjects', () => {
    const state = grantedTurn()
    const resolved = run(state, { kind: 'tick', nowMs: 1_820 })

    expect(resolved.effects).toEqual([])
    expect(granted(resolved.state).grant.interjectWindowClosed).toBe(true)
    expect(granted(resolved.state).counters.grantsIssued).toBe(1)
  })

  it('resolves the interject opportunity at most once', () => {
    const state = grantedTurn()
    const first = run(state, { kind: 'tick', nowMs: 1_820 })
    const second = run(first.state, { kind: 'tick', nowMs: 1_821 })

    expect(granted(first.state).grant.interjectWindowClosed).toBe(true)
    expect(second.effects).toEqual([])
    expect(second.state).toBe(first.state)
  })

  it('closes a completed response without cancelling generation', () => {
    const state = grantedTurn()
    const { grantId } = state.grant

    const result = run(state, {
      kind: 'response_ended',
      grantId,
      outcome: 'completed',
      nowMs: 30,
    })

    expect(result.effects).toEqual([emitted('turn.revoked', { grantId, reason: 'completed' })])
    expect(result.state.phase).toBe('idle')
  })

  it('revokes a cancelled response and cancels generation', () => {
    const state = grantedTurn()
    const { grantId } = state.grant

    const result = run(state, {
      kind: 'response_ended',
      grantId,
      outcome: 'cancelled',
      nowMs: 30,
    })

    expect(result.effects).toEqual([
      emitted('turn.revoked', { grantId, reason: 'cancelled' }),
      { kind: 'cancel_generation', grantId, reason: 'cancelled' },
    ])
    expect(result.state.phase).toBe('idle')
  })

  it('ignores a response for an unknown grant', () => {
    const state = grantedTurn()
    expect(
      run(state, {
        kind: 'response_ended',
        grantId: 'grant:other:1',
        outcome: 'completed',
        nowMs: 30,
      }).effects,
    ).toEqual([])
  })

  it('ignores a response while the window is still open', () => {
    const state = openWindow()
    expect(
      run(state, {
        kind: 'response_ended',
        grantId: 'grant:turn-1:1',
        outcome: 'completed',
        nowMs: 10,
      }).effects,
    ).toEqual([])
  })

  it('revokes an active grant before completing the session', () => {
    const state = grantedTurn()
    const { grantId } = state.grant

    const closed = run(state, { kind: 'close', nowMs: 30 })
    expect(closed.effects).toEqual([
      emitted('turn.revoked', { grantId, reason: 'session_completed' }),
      { kind: 'cancel_generation', grantId, reason: 'session_completed' },
      emitted('session.completed', {}),
      { kind: 'close_session' },
    ])
    expect(closed.state.phase).toBe('ended')

    expect(run(closed.state, { kind: 'close', nowMs: 40 })).toEqual({
      state: closed.state,
      effects: [],
    })
  })

  it('completes an idle session', () => {
    const result = run(INITIAL_ARBITER_STATE, { kind: 'close', nowMs: 10 })
    expect(result.effects).toEqual([emitted('session.completed', {}), { kind: 'close_session' }])
    expect(result.state).toEqual({ phase: 'ended', counters: EMPTY_COUNTERS })
  })

  it('completes a session with an open window', () => {
    const result = run(openWindow(), { kind: 'close', nowMs: 10 })
    expect(result.effects).toEqual([emitted('session.completed', {}), { kind: 'close_session' }])
    expect(result.state.phase).toBe('ended')
  })

  it('drops a decline at the exact window boundary', () => {
    expect(
      run(openWindow(), { kind: 'declined', turnId: 'turn-1', personaId: 'peer', nowMs: 1_000 })
        .effects,
    ).toEqual([])
  })

  it('drops a decline from an ineligible persona', () => {
    expect(
      run(openWindow(), { kind: 'declined', turnId: 'turn-1', personaId: 'client', nowMs: 10 })
        .effects,
    ).toEqual([])
  })

  it('drops a second decline from the same persona', () => {
    const state = run(openWindow(), {
      kind: 'declined',
      turnId: 'turn-1',
      personaId: 'peer',
      nowMs: 10,
    }).state
    expect(
      run(state, { kind: 'declined', turnId: 'turn-1', personaId: 'peer', nowMs: 20 }).effects,
    ).toEqual([])
  })

  it('ignores a tick while idle', () => {
    const state = INITIAL_ARBITER_STATE
    expect(run(state, { kind: 'tick', nowMs: 10 })).toEqual({ state, effects: [] })
  })

  it('does not mutate the input state', () => {
    const state = openWindow()
    const before = JSON.stringify(state)
    run(state, { kind: 'request', request: request('peer'), nowMs: 10 })
    expect(JSON.stringify(state)).toBe(before)
  })
})

describe('turn arbiter input totality', () => {
  const unusableClocks: readonly unknown[] = [undefined, null, 'soon', NaN, Infinity, -Infinity]

  it('drops a request whose payload is not a turn request', () => {
    const state = openWindow()

    expect(runRaw(state, { kind: 'request', request: null, nowMs: 10 })).toEqual({
      state,
      effects: [],
    })
    expect(
      runRaw(state, { kind: 'request', request: request('peer', { urgency: 5 }), nowMs: 10 }),
    ).toEqual({ state, effects: [] })
    expect(
      runRaw(state, {
        kind: 'request',
        request: { ...request('peer'), unexpected: true },
        nowMs: 10,
      }),
    ).toEqual({ state, effects: [] })
  })

  it('drops the input that would otherwise rank with an unusable clock', () => {
    const state = run(openWindow(), { kind: 'request', request: request('peer'), nowMs: 10 }).state
    expect(state.phase).toBe('window_open')

    for (const nowMs of unusableClocks) {
      expect(runRaw(state, { kind: 'request', request: request('manager'), nowMs })).toEqual({
        state,
        effects: [],
      })
    }
  })

  it('drops a decline with an unusable clock', () => {
    const state = run(openWindow(), { kind: 'request', request: request('peer'), nowMs: 10 }).state

    for (const nowMs of unusableClocks) {
      expect(
        runRaw(state, { kind: 'declined', turnId: 'turn-1', personaId: 'manager', nowMs }),
      ).toEqual({ state, effects: [] })
    }
  })

  it('drops a committed turn with an unusable clock instead of opening an immortal window', () => {
    for (const nowMs of unusableClocks) {
      expect(runRaw(INITIAL_ARBITER_STATE, { ...committed(), nowMs })).toEqual({
        state: INITIAL_ARBITER_STATE,
        effects: [],
      })
    }
  })

  it('drops a committed turn whose clock would overflow the Date range', () => {
    const almostValid = { ...committed(), nowMs: MAX_TIME_VALUE_MS - 1 }
    expect(runRaw(INITIAL_ARBITER_STATE, almostValid)).toEqual({
      state: INITIAL_ARBITER_STATE,
      effects: [],
    })
  })

  it('drops a committed turn whose fields are not well typed', () => {
    const malformed: readonly unknown[] = [
      { ...committed(), eligiblePersonaIds: null },
      { ...committed(), eligiblePersonaIds: ['manager', 7] },
      { ...committed(), eligiblePersonaIds: [''] },
      { ...committed(), seed: 'seven' },
      { ...committed(), turnId: '' },
      { ...committed(), unexpected: true },
    ]

    for (const input of malformed) {
      expect(runRaw(INITIAL_ARBITER_STATE, input)).toEqual({
        state: INITIAL_ARBITER_STATE,
        effects: [],
      })
    }
  })

  it('drops a decline whose persona id is not a string', () => {
    const state = openWindow()
    expect(
      runRaw(state, { kind: 'declined', turnId: 'turn-1', personaId: null, nowMs: 10 }),
    ).toEqual({ state, effects: [] })
  })

  it('drops a tick with an unusable clock', () => {
    const state = openWindow()
    for (const nowMs of unusableClocks) {
      expect(runRaw(state, { kind: 'tick', nowMs })).toEqual({ state, effects: [] })
    }
  })

  it('drops an unknown response outcome instead of revoking the grant', () => {
    const state = grantedTurn()

    expect(
      runRaw(state, {
        kind: 'response_ended',
        grantId: state.grant.grantId,
        outcome: 'bogus',
        nowMs: 30,
      }),
    ).toEqual({ state, effects: [] })
    expect(state.phase).toBe('grant_active')
  })

  it('drops a response or a close that carries an unusable clock', () => {
    const state = grantedTurn()

    for (const nowMs of unusableClocks) {
      expect(
        runRaw(state, {
          kind: 'response_ended',
          grantId: state.grant.grantId,
          outcome: 'completed',
          nowMs,
        }),
      ).toEqual({ state, effects: [] })
      expect(runRaw(state, { kind: 'close', nowMs })).toEqual({ state, effects: [] })
    }
  })

  it('drops an unknown input kind and a non-object input in every phase', () => {
    const states: readonly ArbiterState[] = [
      INITIAL_ARBITER_STATE,
      openWindow(),
      grantedTurn(),
      run(openWindow(), { kind: 'close', nowMs: 10 }).state,
    ]
    const malformed: readonly unknown[] = [null, undefined, 42, 'tick', [], {}, { kind: 'nope' }]

    for (const state of states) {
      for (const input of malformed) {
        expect(runRaw(state, input)).toEqual({ state, effects: [] })
      }
    }
  })
})
