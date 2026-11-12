import { describe, expect, it } from 'vitest'
import type { PersonaPolicyDecision, PersonaTurnPolicy } from './arbiter-port.js'
import type { TurnRequest } from './events.js'
import { decideWithin, interjectRequestFor, speakRequestFor } from './policy-decisions.js'

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: 'turn-1',
    personaId: 'manager',
    action: 'speak',
    urgency: 0.2,
    confidence: 0.9,
    addressedByUser: false,
    objectiveRelevance: 0.4,
    ...overrides,
  }
}

const decline: PersonaPolicyDecision = { kind: 'decline' }

describe('policy decisions', () => {
  it('returns a decision unchanged', async () => {
    const policy: PersonaTurnPolicy = {
      decide: () => ({ kind: 'request', request: request() }),
    }
    const outcome = await decideWithin(
      policy,
      {
        personaId: 'manager',
        turnId: 'turn-1',
        action: 'speak',
        messages: [],
        lang: 'en',
        context: undefined,
      },
      50,
    )

    expect(outcome).toEqual({
      kind: 'decision',
      decision: { kind: 'request', request: request() },
    })
  })

  it('turns a thrown policy into an error, never a decline', async () => {
    const policy: PersonaTurnPolicy = {
      decide: () => {
        throw new Error('boom')
      },
    }
    const outcome = await decideWithin(
      policy,
      {
        personaId: 'manager',
        turnId: 'turn-1',
        action: 'speak',
        messages: [],
        lang: 'en',
        context: undefined,
      },
      50,
    )

    expect(outcome).toEqual({ kind: 'error' })
  })

  it('bounds a hanging policy with the request window', async () => {
    const policy: PersonaTurnPolicy = { decide: () => new Promise(() => undefined) }
    const outcome = await decideWithin(
      policy,
      {
        personaId: 'manager',
        turnId: 'turn-1',
        action: 'speak',
        messages: [],
        lang: 'en',
        context: undefined,
      },
      5,
    )

    expect(outcome).toEqual({ kind: 'timeout' })
  })

  it('accepts only a speak request that matches the turn and persona', () => {
    expect(speakRequestFor('turn-1', 'manager', { kind: 'request', request: request() })).toEqual(
      request(),
    )
    expect(
      speakRequestFor('turn-1', 'peer', { kind: 'request', request: request() }),
    ).toBeUndefined()
    expect(
      speakRequestFor('turn-2', 'manager', { kind: 'request', request: request() }),
    ).toBeUndefined()
    expect(
      speakRequestFor('turn-1', 'manager', {
        kind: 'request',
        request: request({ action: 'interject', targetGrantId: 'grant-1' }),
      }),
    ).toBeUndefined()
    expect(speakRequestFor('turn-1', 'manager', decline)).toBeUndefined()
  })

  it('accepts only an interject request that names the active grant', () => {
    const interject = request({ action: 'interject', targetGrantId: 'grant-1' })
    expect(
      interjectRequestFor('turn-1', 'manager', 'grant-1', { kind: 'request', request: interject }),
    ).toEqual(interject)
    expect(
      interjectRequestFor('turn-2', 'manager', 'grant-1', { kind: 'request', request: interject }),
    ).toBeUndefined()
    expect(
      interjectRequestFor('turn-1', 'manager', 'grant-1', {
        kind: 'request',
        request: request({ targetGrantId: 'grant-1' }),
      }),
    ).toBeUndefined()
    expect(
      interjectRequestFor('turn-1', 'manager', 'grant-2', { kind: 'request', request: interject }),
    ).toBeUndefined()
    expect(
      interjectRequestFor('turn-1', 'peer', 'grant-1', { kind: 'request', request: interject }),
    ).toBeUndefined()
    expect(
      interjectRequestFor('turn-1', 'manager', 'grant-1', { kind: 'request', request: request() }),
    ).toBeUndefined()
    expect(interjectRequestFor('turn-1', 'manager', 'grant-1', decline)).toBeUndefined()
  })
})
