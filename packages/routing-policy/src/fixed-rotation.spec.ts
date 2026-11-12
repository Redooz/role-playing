import type { PersonaPolicyInput } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import {
  createFixedRotationLivePolicy,
  fixedRotationPersonaForTurn,
  FIXED_ROTATION_POLICY_ID,
  FIXED_ROTATION_POLICY_VERSION,
} from './fixed-rotation.js'
import { makeContext } from './fixtures.js'
import type { RoutingContext } from './schemas.js'

function input(personaId: string, turnId = 'turn-1'): PersonaPolicyInput<RoutingContext> {
  return {
    personaId,
    turnId,
    action: 'speak',
    messages: [],
    lang: 'en',
    context: makeContext({ turnId }),
  }
}

describe('fixed-rotation baseline policy', () => {
  it('pins the baseline identity and version', () => {
    expect(FIXED_ROTATION_POLICY_ID).toBe('fixed-rotation')
    expect(FIXED_ROTATION_POLICY_VERSION).toBe('m3b-fixed-rotation-v1')
  })

  it('lets exactly the rotated persona speak per turn', async () => {
    const policy = createFixedRotationLivePolicy(['manager', 'peer'])
    const expected = fixedRotationPersonaForTurn('turn-1', ['manager', 'peer'])
    const manager = await policy.decide(input('manager'))
    const peer = await policy.decide(input('peer'))
    expect(manager.kind).toBe(expected === 'manager' ? 'request' : 'decline')
    expect(peer.kind).toBe(expected === 'peer' ? 'request' : 'decline')
    const winner = manager.kind === 'request' ? manager : peer
    expect(winner).toMatchObject({
      kind: 'request',
      request: {
        turnId: 'turn-1',
        action: 'speak',
        urgency: 0.5,
        confidence: 1,
        addressedByUser: false,
        objectiveRelevance: 0,
      },
    })
  })

  it('rotates the winner across turns with the same seed', async () => {
    const policy = createFixedRotationLivePolicy(['manager', 'peer'])
    const winners = new Set<string>()
    for (let turn = 1; turn <= 20; turn += 1) {
      for (const personaId of ['manager', 'peer']) {
        const decision = await policy.decide(input(personaId, `turn-${turn}`))
        if (decision.kind === 'request') winners.add(personaId)
      }
    }
    expect(winners).toEqual(new Set(['manager', 'peer']))
  })

  it('declines every interjection for every persona', () => {
    const policy = createFixedRotationLivePolicy(['manager', 'peer'])
    for (const personaId of ['manager', 'peer']) {
      expect(
        policy.decide({ ...input(personaId), action: 'interject', targetGrantId: 'g-1' }),
      ).toEqual({ kind: 'decline' })
    }
  })

  it('rejects a one-persona or duplicate rotation and a mismatched turn', () => {
    expect(() => createFixedRotationLivePolicy(['manager'])).toThrow(/at least two/u)
    expect(() => createFixedRotationLivePolicy(['manager', 'manager'])).toThrow(/unique/u)
    const policy = createFixedRotationLivePolicy(['manager', 'peer'])
    expect(() => policy.decide({ ...input('manager'), turnId: 'turn-2' })).toThrow(
      /context turn "turn-1"/u,
    )
  })
})
