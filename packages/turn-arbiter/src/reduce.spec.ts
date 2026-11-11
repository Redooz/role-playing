import { rankTurnRequests } from '@rp/routing-policy'
import { sessionEventSchema, type PersonaId, type TurnRequest } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import { parseTurnArbiterConfig } from './config.js'
import { makeTurnContext } from './fixtures.js'
import { INITIAL_ARBITER_STATE, reduce } from './reduce.js'
import type {
  ArbiterEffect,
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
function grantedTurn(): ArbiterState {
  const first = run(openWindow(), { kind: 'request', request: request('peer'), nowMs: 10 })
  const second = run(first.state, { kind: 'request', request: request('manager'), nowMs: 20 })
  return second.state
}

function kinds(effects: readonly ArbiterEffect[]): string[] {
  return effects.map((effect) =>
    effect.kind === 'emit_event' ? `event:${effect.type}` : effect.kind,
  )
}

function granted(result: ArbiterResult): NonNullable<ArbiterState['grant']> {
  if (result.state.grant === undefined) throw new Error('expected a grant')
  return result.state.grant
}

describe('turn arbiter normal flow', () => {
  it('opens a bounded request window on a committed user utterance', () => {
    const result = run(INITIAL_ARBITER_STATE, committed())

    expect(result.state.phase).toBe('window_open')
    expect(result.state.turn?.windowEndsAtMs).toBe(1_000)
    expect(result.state.grantsIssued).toBe(0)
    expect(kinds(result.effects)).toEqual(['event:turn.opened'])
  })

  it('ignores a committed utterance while a window is open', () => {
    const state = openWindow()
    expect(run(state, committed({ turnId: 'turn-2' }))).toEqual({ state, effects: [] })
  })

  it('records one request per eligible persona', () => {
    const result = run(openWindow(), { kind: 'request', request: request('peer'), nowMs: 10 })

    expect(result.state.turn?.requests).toHaveLength(1)
    expect(kinds(result.effects)).toEqual(['event:persona.requested_turn'])
  })

  it('decides as soon as every eligible persona has responded', () => {
    const first = run(openWindow(), { kind: 'request', request: request('peer'), nowMs: 10 })
    expect(first.state.phase).toBe('window_open')

    const second = run(first.state, {
      kind: 'request',
      request: request('manager', { addressedByUser: true }),
      nowMs: 20,
    })

    expect(second.state.phase).toBe('grant_active')
    expect(granted(second).personaId).toBe('manager')
    expect(kinds(second.effects)).toEqual([
      'event:persona.requested_turn',
      'event:turn.granted',
      'start_generation',
    ])
  })

  it('emits a valid §3.2 grant with an ISO expiry', () => {
    const first = run(openWindow(), { kind: 'request', request: request('peer'), nowMs: 10 })
    const result = run(first.state, {
      kind: 'request',
      request: request('manager', { addressedByUser: true }),
      nowMs: 20,
    })

    const emitted = result.effects.find(
      (effect) => effect.kind === 'emit_event' && effect.type === 'turn.granted',
    )
    expect(emitted).toBeDefined()
    if (emitted?.kind !== 'emit_event' || emitted.type !== 'turn.granted') {
      throw new Error('expected turn.granted')
    }

    expect(sessionEventSchema.parse({ type: emitted.type, payload: emitted.payload })).toBeDefined()
    expect(emitted.payload.grant).toEqual({
      turnId: 'turn-1',
      grantId: 'grant:turn-1:1',
      personaId: 'manager',
      expiresAt: '1970-01-01T00:00:05.020Z',
    })
  })

  it('yields to the learner when every persona declines', () => {
    const first = run(openWindow(), {
      kind: 'declined',
      turnId: 'turn-1',
      personaId: 'peer',
      nowMs: 10,
    })
    expect(kinds(first.effects)).toEqual(['event:persona.declined'])
    expect(first.state.phase).toBe('window_open')

    const second = run(first.state, {
      kind: 'declined',
      turnId: 'turn-1',
      personaId: 'manager',
      nowMs: 20,
    })
    expect(kinds(second.effects)).toEqual(['event:persona.declined', 'event:turn.user_yielded'])
    expect(second.state.phase).toBe('idle')
  })

  it('waits for the window to close before deciding', () => {
    const state = run(openWindow(), { kind: 'request', request: request('peer'), nowMs: 10 }).state

    expect(run(state, { kind: 'tick', nowMs: 999 })).toEqual({ state, effects: [] })

    const closed = run(state, { kind: 'tick', nowMs: 1_000 })
    expect(closed.state.phase).toBe('grant_active')
    expect(granted(closed).personaId).toBe('peer')
  })

  it('yields when the window closes with no requests', () => {
    const closed = run(openWindow(), { kind: 'tick', nowMs: 1_000 })

    expect(kinds(closed.effects)).toEqual(['event:turn.user_yielded'])
    expect(closed.state.phase).toBe('idle')
  })

  it('yields immediately when no persona is eligible', () => {
    const result = run(INITIAL_ARBITER_STATE, committed({ eligiblePersonaIds: [] }))

    expect(kinds(result.effects)).toEqual(['event:turn.opened', 'event:turn.user_yielded'])
    expect(result.state.phase).toBe('idle')
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

  it('grants one deterministic speaker when two requests tie', () => {
    const manager = request('manager')
    const peer = request('peer')
    const expected = rankTurnRequests(makeTurnContext(), [manager, peer], 7)[0]?.personaId
    expect(expected).toBeDefined()

    const first = run(openWindow(), { kind: 'request', request: manager, nowMs: 10 })
    const second = run(first.state, { kind: 'request', request: peer, nowMs: 20 })
    expect(granted(second).personaId).toBe(expected)

    const replayFirst = run(openWindow(), { kind: 'request', request: manager, nowMs: 10 })
    const replaySecond = run(replayFirst.state, { kind: 'request', request: peer, nowMs: 20 })
    expect(granted(replaySecond).grantId).toBe(granted(second).grantId)
  })

  it('issues unique grant ids across turns', () => {
    const first = grantedTurn()
    const firstGrant = first.grant
    if (firstGrant === undefined) throw new Error('expected a grant')

    const ended = run(first, {
      kind: 'response_ended',
      grantId: firstGrant.grantId,
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

    expect(granted(second).grantId).not.toBe(firstGrant.grantId)
    expect(second.state.grantsIssued).toBe(2)
  })
})

describe('turn arbiter grant lifecycle', () => {
  it('revokes an expired grant once and returns to idle', () => {
    const state = grantedTurn()
    const grant = state.grant
    if (grant === undefined) throw new Error('expected a grant')

    const expired = run(state, { kind: 'tick', nowMs: grant.expiresAtMs })
    expect(kinds(expired.effects)).toEqual(['event:turn.revoked', 'cancel_generation'])
    expect(expired.state.phase).toBe('idle')

    expect(run(expired.state, { kind: 'tick', nowMs: grant.expiresAtMs + 1 })).toEqual({
      state: expired.state,
      effects: [],
    })
  })

  it('closes a completed response without cancelling generation', () => {
    const state = grantedTurn()
    const grant = state.grant
    if (grant === undefined) throw new Error('expected a grant')

    const result = run(state, {
      kind: 'response_ended',
      grantId: grant.grantId,
      outcome: 'completed',
      nowMs: 30,
    })

    expect(kinds(result.effects)).toEqual(['event:turn.revoked'])
    expect(result.state.phase).toBe('idle')
    expect(result.effects[0]).toMatchObject({
      kind: 'emit_event',
      type: 'turn.revoked',
      payload: { grantId: grant.grantId, reason: 'completed' },
    })
  })

  it('revokes a cancelled response and cancels generation', () => {
    const state = grantedTurn()
    const grant = state.grant
    if (grant === undefined) throw new Error('expected a grant')

    const result = run(state, {
      kind: 'response_ended',
      grantId: grant.grantId,
      outcome: 'cancelled',
      nowMs: 30,
    })

    expect(kinds(result.effects)).toEqual(['event:turn.revoked', 'cancel_generation'])
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

  it('revokes an active grant before completing the session', () => {
    const state = grantedTurn()
    const grant = state.grant
    if (grant === undefined) throw new Error('expected a grant')

    const closed = run(state, { kind: 'close', nowMs: 30 })
    expect(kinds(closed.effects)).toEqual([
      'event:turn.revoked',
      'cancel_generation',
      'event:session.completed',
      'close_session',
    ])
    expect(closed.state.phase).toBe('ended')

    expect(run(closed.state, { kind: 'close', nowMs: 40 })).toEqual({
      state: closed.state,
      effects: [],
    })
  })

  it('completes an idle session', () => {
    const result = run(INITIAL_ARBITER_STATE, { kind: 'close', nowMs: 10 })
    expect(kinds(result.effects)).toEqual(['event:session.completed', 'close_session'])
    expect(result.state.phase).toBe('ended')
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
