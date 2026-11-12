import { describe, expect, it } from 'vitest'
import type {
  SessionArbiterEffect,
  SessionArbiterInput,
  SessionArbiterPort,
} from './arbiter-port.js'
import { ArbiterBridge } from './arbiter-bridge.js'
import type { SessionEvent } from './events.js'

/**
 * Unit contract for the effect adapter.
 *
 * The driver integration tests prove the reducer seam end to end; this suite
 * pins the small decisions the bridge makes on its own: which events are
 * forwarded, when a grant deadline is captured or falls back, and when a cancel
 * also clears a not-yet-started generation.
 */

type State = { readonly reductions: number }

function arbiterReturning(
  effectsFor: (input: SessionArbiterInput<string>) => readonly SessionArbiterEffect[],
): SessionArbiterPort<State, string> {
  return {
    initialState: { reductions: 0 },
    reduce(state, input) {
      return {
        state: { reductions: state.reductions + 1 },
        effects: effectsFor(input),
      }
    },
  }
}

function grantEffect(expiresAt: string): SessionArbiterEffect {
  return {
    kind: 'emit_event',
    type: 'turn.granted',
    payload: {
      grant: {
        turnId: 'turn-1',
        grantId: 'grant-1',
        personaId: 'manager',
        expiresAt,
      },
    },
  }
}

interface HostState {
  readonly pushed: SessionEvent[]
  readonly cancelled: { grantId: string; reason: string }[]
  ended: boolean
}

function newHostState(): HostState {
  return { pushed: [], cancelled: [], ended: false }
}

function host(state: HostState) {
  return {
    push(event: SessionEvent) {
      state.pushed.push(event)
    },
    cancel(grantId: string, reason: string) {
      state.cancelled.push({ grantId, reason })
    },
    end() {
      state.ended = true
    },
  }
}

describe('arbiter bridge', () => {
  it('forwards effects in order and exposes the granted turn and generation', async () => {
    const seen = newHostState()
    const bridge = new ArbiterBridge(
      arbiterReturning(() => [
        grantEffect('2026-11-11T12:30:00.000Z'),
        { kind: 'start_generation', grantId: 'grant-1', personaId: 'manager' },
      ]),
      host(seen),
      { defaultDeadlineMs: 60_000, now: () => 0 },
    )

    await bridge.reduce({ kind: 'tick', nowMs: 0 })

    expect(seen.pushed.map((event) => event.type)).toEqual(['turn.granted'])
    expect(bridge.grantTurnId).toBe('turn-1')
    expect(bridge.grantExpiresAtMs).toBe(Date.parse('2026-11-11T12:30:00.000Z'))
    expect(bridge.takePendingStart()).toEqual({ grantId: 'grant-1', personaId: 'manager' })
    expect(bridge.takePendingStart()).toBeUndefined()
  })

  it('falls back to the configured lifetime when a grant deadline is unusable', async () => {
    const seen = newHostState()
    const bridge = new ArbiterBridge(
      arbiterReturning(() => [grantEffect('not-a-date')]),
      host(seen),
      {
        defaultDeadlineMs: 5_000,
        now: () => 1_000,
      },
    )

    await bridge.reduce({ kind: 'tick', nowMs: 1_000 })

    expect(bridge.grantExpiresAtMs).toBe(6_000)
  })

  it('clears a pending generation when its own grant is cancelled', async () => {
    const seen = newHostState()
    const bridge = new ArbiterBridge(
      arbiterReturning((input) =>
        input.kind === 'tick'
          ? [
              { kind: 'start_generation', grantId: 'grant-1', personaId: 'manager' },
              { kind: 'cancel_generation', grantId: 'grant-1', reason: 'user_barge_in' },
            ]
          : [],
      ),
      host(seen),
      { defaultDeadlineMs: 60_000, now: () => 0 },
    )

    await bridge.reduce({ kind: 'tick', nowMs: 0 })

    expect(bridge.takePendingStart()).toBeUndefined()
    expect(seen.cancelled).toEqual([{ grantId: 'grant-1', reason: 'user_barge_in' }])
  })

  it('forwards a cancel for a different grant without touching the pending one', async () => {
    const seen = newHostState()
    const bridge = new ArbiterBridge(
      arbiterReturning((input) =>
        input.kind === 'tick'
          ? [
              { kind: 'start_generation', grantId: 'grant-2', personaId: 'peer' },
              { kind: 'cancel_generation', grantId: 'grant-1', reason: 'interrupted' },
            ]
          : [],
      ),
      host(seen),
      { defaultDeadlineMs: 60_000, now: () => 0 },
    )

    await bridge.reduce({ kind: 'tick', nowMs: 0 })

    expect(bridge.takePendingStart()).toEqual({ grantId: 'grant-2', personaId: 'peer' })
    expect(seen.cancelled).toEqual([{ grantId: 'grant-1', reason: 'interrupted' }])
  })

  it('ends the session on close_session', async () => {
    const seen = newHostState()
    const bridge = new ArbiterBridge(
      arbiterReturning(() => [{ kind: 'close_session' }]),
      host(seen),
      { defaultDeadlineMs: 60_000, now: () => 0 },
    )

    await bridge.reduce({ kind: 'close', nowMs: 0 })

    expect(seen.ended).toBe(true)
  })
})
