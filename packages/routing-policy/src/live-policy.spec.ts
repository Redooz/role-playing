import type { PersonaPolicyInput } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import { makeContext } from './fixtures.js'
import {
  createDetPersonaLivePolicy,
  DET_PERSONA_LIVE_POLICY_ID,
  DET_PERSONA_LIVE_POLICY_VERSION,
} from './live-policy.js'
import type { RoutingContext } from './schemas.js'

function input(
  overrides: Partial<PersonaPolicyInput<RoutingContext>> = {},
): PersonaPolicyInput<RoutingContext> {
  return {
    personaId: 'peer',
    turnId: 'turn-1',
    action: 'speak',
    messages: [],
    lang: 'en',
    context: makeContext(),
    ...overrides,
  }
}

describe('det-persona live policy', () => {
  it('pins the control-arm identity and version', () => {
    expect(DET_PERSONA_LIVE_POLICY_ID).toBe('det-persona')
    expect(DET_PERSONA_LIVE_POLICY_VERSION).toBe('m3b-det-persona-live-policy-v1')
  })

  it('requests the turn for a directly addressed persona', () => {
    const decision = createDetPersonaLivePolicy().decide(input())
    expect(decision).toEqual({
      kind: 'request',
      request: {
        turnId: 'turn-1',
        personaId: 'peer',
        action: 'speak',
        urgency: 1,
        confidence: 1,
        addressedByUser: true,
        objectiveRelevance: 1,
      },
    })
  })

  it('requests for an objective-relevant persona that was not named', () => {
    const decision = createDetPersonaLivePolicy().decide(
      input({
        personaId: 'manager',
        context: makeContext({ lastUser: 'What deadline works for you?' }),
      }),
    )
    expect(decision).toEqual({
      kind: 'request',
      request: {
        turnId: 'turn-1',
        personaId: 'manager',
        action: 'speak',
        urgency: 0.6,
        confidence: 1,
        addressedByUser: false,
        objectiveRelevance: 1,
      },
    })
  })

  it('declines when the persona has no relevant contribution', () => {
    const decision = createDetPersonaLivePolicy().decide(
      input({ personaId: 'client', context: makeContext({ lastUser: 'Thanks, noted.' }) }),
    )
    expect(decision).toEqual({ kind: 'decline' })
  })

  it('interjects only when the learner directly addresses the persona', () => {
    const policy = createDetPersonaLivePolicy()
    expect(policy.decide(input({ action: 'interject', targetGrantId: 'grant-1' }))).toEqual({
      kind: 'request',
      request: {
        turnId: 'turn-1',
        personaId: 'peer',
        action: 'interject',
        urgency: 1,
        confidence: 1,
        addressedByUser: true,
        objectiveRelevance: 1,
        targetGrantId: 'grant-1',
      },
    })

    expect(
      policy.decide(
        input({
          personaId: 'manager',
          action: 'interject',
          targetGrantId: 'grant-1',
        }),
      ),
    ).toEqual({ kind: 'decline' })
  })

  it('rejects an interjection without a target grant', () => {
    expect(() => createDetPersonaLivePolicy().decide(input({ action: 'interject' }))).toThrow(
      /target grant id/u,
    )
  })

  it('rejects an unknown persona instead of fabricating a decline', () => {
    expect(() => createDetPersonaLivePolicy().decide(input({ personaId: 'stranger' }))).toThrow(
      /no eligible persona "stranger"/u,
    )
  })

  it('rejects a policy input that names a different turn than the context', () => {
    expect(() => createDetPersonaLivePolicy().decide(input({ turnId: 'turn-2' }))).toThrow(
      /turn "turn-2" for context turn "turn-1"/u,
    )
  })

  it('is stable across repeated calls with the same input', () => {
    const policy = createDetPersonaLivePolicy()
    const first = policy.decide(input())
    const second = policy.decide(input())
    expect(second).toEqual(first)
  })
})
