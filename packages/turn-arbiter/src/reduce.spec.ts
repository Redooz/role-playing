import { rankTurnRequests } from '@rp/routing-policy'
import { sessionEventSchema, type PersonaId, type TurnRequest } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import { parseTurnArbiterConfig } from './config.js'
import { makeTurnContext } from './fixtures.js'
import { INITIAL_ARBITER_STATE, reduce } from './reduce.js'
import type {
  ArbiterEffect,
  ArbiterGrantState,
  ArbiterInput,
  ArbiterResult,
  ArbiterState,
  UserCommittedInput,
} from './types.js'

const CONFIG = parseTurnArbiterConfig({ requestWindowMs: 1_000, grantTtlMs: 5_000 })

function request(personaId: PersonaId, overrides: Partial<TurnRequest> = {}): TurnRequest {
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

function committed(overrides: Partial<UserCommittedInput> = {}): UserCommittedInput {
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

function run(state: ArbiterState, input: ArbiterInput): ArbiterResult {
  return reduce(state, input, CONFIG)
}

function openWindow(): ArbiterState {
  return run(INITIAL_ARBITER_STATE, committed()).state
}

/** A turn where both personas requested and one holds the grant. */
function grantedTurn(): ArbiterGrantState {
  const first = run(openWindow(), { kind: 'request', request: request('peer'), nowMs: 10 })
  const second = run(first.state, { kind: 'request', request: request('manager'), nowMs: 20 })
  return granted(second.state)
}

function granted(state: ArbiterState): ArbiterGrantState {
  if (state.phase !== 'grant_active') throw new Error('expected a grant')
  return state
}

function event(type: string, payload: unknown): ArbiterEffect {
  return { kind: 'emit_event', type, payload } as ArbiterEffect
}

describe('turn arbiter normal flow', () => {
  it('opens a bounded request window on a committed user utterance', () => {
    const result = run(INITIAL_ARBITER_STATE, committed())

    expect(result.state.phase).toBe('window_open')
    expect(result.state.phase === 'window_open' && result.state.turn.windowEndsAtMs).toBe(1_000)
    expect(result.state.grantsIssued).toBe(0)
    expect(result.state.phase === 'window_open' && result.state.turn.declinedBy).toEqual([])
    expect(result.effects).toEqual([event('turn.opened', { turnId: 'turn-1' })])
  })

  it('ignores a committed utterance while a window is open', () => {
    const state = openWindow()
    expect(run(state, committed({ turnId: 'turn-2' }))).toEqual({ state, effects: [] })
  })

  it('records one request per eligible persona', () => {
    const peer = request('peer')
    const result = run(openWindow(), { kind: 'request', request: peer, nowMs: 10 })

    expect(result.state.phase === 'window_open' && result.state.turn.requests).toEqual([peer])
    expect(result.effects).toEqual([event('persona.requested_turn', { request: peer })])
  })

  it('decides as soon as every eligible persona has responded', () => {
    const peer = request('peer')
    const manager = request('manager', { addressedByUser: true })
    const first = run(openWindow(), { kind: 'request', request: peer, nowMs: 10 })
    expect(first.state.phase).toBe('window_open')

    const second = run(first.state, { kind: 'request', request: manager, nowMs: 20 })

    expect(granted(second.state).grant.personaId).toBe('manager')
    expect(second.effects).toEqual([
      event('persona.requested_turn', { request: manager }),
      event('turn.granted', {
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
      event('persona.declined', { turnId: 'turn-1', personaId: 'peer' }),
    ])
    expect(first.state.phase).toBe('window_open')

    const second = run(first.state, {
      kind: 'declined',
      turnId: 'turn-1',
      personaId: 'manager',
      nowMs: 20,
    })
    expect(second.effects).toEqual([
      event('persona.declined', { turnId: 'turn-1', personaId: 'manager' }),
      event('turn.user_yielded', { reason: 'all_declined' }),
    ])
    expect(second.state.phase).toBe('idle')
  })

  it('waits for the window to close before deciding', () => {
    const state = run(openWindow(), { kind: 'request', request: request('peer'), nowMs: 10 }).state

    expect(run(state, { kind: 'tick', nowMs: 999 })).toEqual({ state, effects: [] })

    const closed = run(state, { kind: 'tick', nowMs: 1_000 })
    expect(granted(closed.state).grant.personaId).toBe('peer')
  })

  it('yields when the window closes with no requests', () => {
    const closed = run(openWindow(), { kind: 'tick', nowMs: 1_000 })

    expect(closed.effects).toEqual([event('turn.user_yielded', { reason: 'all_declined' })])
    expect(closed.state.phase).toBe('idle')
  })

  it('yields immediately when no persona is eligible', () => {
    const result = run(INITIAL_ARBITER_STATE, committed({ eligiblePersonaIds: [] }))

    expect(result.effects).toEqual([
      event('turn.opened', { turnId: 'turn-1' }),
      event('turn.user_yielded', { reason: 'all_declined' }),
    ])
    expect(result.state).toEqual({ phase: 'idle', grantsIssued: 0 })
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

  it('drops a request while a grant is active', () => {
    const state = grantedTurn()
    expect(run(state, { kind: 'request', request: request('manager'), nowMs: 30 }).effects).toEqual(
      [],
    )
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
    expect(granted(second.state).grantsIssued).toBe(2)
  })
})

describe('turn arbiter grant lifecycle', () => {
  it('revokes an expired grant once and returns to idle', () => {
    const state = grantedTurn()
    const { grantId, expiresAtMs } = state.grant

    const expired = run(state, { kind: 'tick', nowMs: expiresAtMs })
    expect(expired.effects).toEqual([
      event('turn.revoked', { grantId, reason: 'timeout' }),
      { kind: 'cancel_generation', grantId, reason: 'timeout' },
    ])
    expect(expired.state.phase).toBe('idle')

    expect(run(expired.state, { kind: 'tick', nowMs: expiresAtMs + 1 })).toEqual({
      state: expired.state,
      effects: [],
    })
  })

  it('keeps an unexpired grant across a tick after the window closes', () => {
    const state = grantedTurn()
    expect(run(state, { kind: 'tick', nowMs: 2_000 })).toEqual({ state, effects: [] })
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

    expect(result.effects).toEqual([event('turn.revoked', { grantId, reason: 'completed' })])
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
      event('turn.revoked', { grantId, reason: 'cancelled' }),
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
      event('turn.revoked', { grantId, reason: 'session_completed' }),
      { kind: 'cancel_generation', grantId, reason: 'session_completed' },
      event('session.completed', {}),
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
    expect(result.effects).toEqual([event('session.completed', {}), { kind: 'close_session' }])
    expect(result.state).toEqual({ phase: 'ended', grantsIssued: 0 })
  })

  it('completes a session with an open window', () => {
    const result = run(openWindow(), { kind: 'close', nowMs: 10 })
    expect(result.effects).toEqual([event('session.completed', {}), { kind: 'close_session' }])
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
