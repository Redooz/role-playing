import { describe, expect, it } from 'vitest'
import type { RoutingMatrixEntry } from './routing-matrix.js'
import { familyBreakdown } from './routing-families.js'

const request = {
  turnId: 'turn-1',
  personaId: 'manager',
  action: 'speak' as const,
  urgency: 0.5,
  confidence: 0.5,
  addressedByUser: false,
  objectiveRelevance: 0.5,
}

function artifact(outcome: 'speak' | 'yield' | 'incomplete'): RoutingMatrixEntry['artifact'] {
  const base = {
    schemaVersion: '1.0.0' as const,
    kind: 'routing.decision' as const,
    contentClass: 'restricted' as const,
    trialId: 'trial',
    taskId: 'task',
    arm: { topology: 'central_selection' as const, judgmentSource: 'jev' as const },
    contextHash: '0'.repeat(64),
    policyLatencyMs: 1,
  }
  if (outcome === 'incomplete') {
    return { ...base, outcome: 'infrastructure_incomplete', observation: { kind: 'none' } }
  }
  return {
    ...base,
    outcome: 'completed',
    observation: { kind: 'deterministic' },
    decision: {
      schemaVersion: '1.1.0',
      decisionId: 'decision-1',
      turnId: 'turn-1',
      lang: 'en',
      topology: 'central_selection',
      judgmentSource: 'jev',
      policyVersion: 'm3d-jev-central-v2',
      eligiblePersonaIds: ['manager', 'peer'],
      requests: outcome === 'speak' ? [request] : [],
      declines:
        outcome === 'speak'
          ? [{ personaId: 'peer', reason: 'not_owner' }]
          : [
              { personaId: 'manager', reason: 'self_directed_move' },
              { personaId: 'peer', reason: 'self_directed_move' },
            ],
      unsettledPersonas: [],
      moveJudgments: {
        scope: 'central',
        move: { closingMove: 0.1, selfAnswer: 0.1, thinkingAloud: 0.1, sideComment: 0.1 },
      },
      outcome:
        outcome === 'speak'
          ? { kind: 'speak', personaId: 'manager', request }
          : { kind: 'user_yield', reason: 'all_declined' },
      fallback: { kind: 'none' },
    },
  }
}

function entry(
  outcome: 'speak' | 'yield' | 'incomplete',
  family: string | undefined,
  label: { acceptablePersonaIds: string[]; allowUserYield: boolean },
): RoutingMatrixEntry {
  return {
    armId: 'jev-central',
    lang: 'en',
    artifact: artifact(outcome),
    label: { intent: 'post-demo-handover', labelSource: 'agent', family, ...label },
  }
}

describe('familyBreakdown', () => {
  it('rates a family over completed speak and silence decisions', () => {
    const readings = familyBreakdown([
      entry('speak', 'TT-S5', { acceptablePersonaIds: ['manager'], allowUserYield: false }),
      entry('yield', 'TT-S5', { acceptablePersonaIds: ['manager'], allowUserYield: false }),
      entry('yield', 'TT-S6', { acceptablePersonaIds: [], allowUserYield: true }),
    ])
    expect(readings).toHaveLength(2)
    expect(readings[0]).toMatchObject({
      family: 'TT-S5',
      total: 2,
      completed: 2,
      incomplete: 0,
      appropriate: 1,
      rated: 2,
      mixed: 0,
      rate: 0.5,
    })
    expect(readings[1]).toMatchObject({ family: 'TT-S6', appropriate: 1, rate: 1 })
  })

  it('counts an incomplete decision and keeps it out of the denominator', () => {
    const [reading] = familyBreakdown([
      entry('incomplete', 'TT-S5', { acceptablePersonaIds: ['manager'], allowUserYield: false }),
    ])
    expect(reading).toMatchObject({ total: 1, completed: 0, incomplete: 1, rated: 0, rate: null })
  })

  it('counts a mixed label and never rates it', () => {
    const [reading] = familyBreakdown([
      entry('speak', 'TT-S5', { acceptablePersonaIds: ['manager'], allowUserYield: true }),
    ])
    expect(reading).toMatchObject({ completed: 1, rated: 0, mixed: 1, rate: null })
  })

  it('names an unlabelled family instead of merging it', () => {
    const [reading] = familyBreakdown([
      entry('speak', undefined, { acceptablePersonaIds: ['manager'], allowUserYield: false }),
    ])
    expect(reading?.family).toBe('unlabelled')
  })

  it('separates arms and languages and sorts them', () => {
    const readings = familyBreakdown([
      { ...entry('speak', 'TT-S6', { acceptablePersonaIds: ['manager'], allowUserYield: false }) },
      {
        ...entry('speak', 'TT-S5', { acceptablePersonaIds: ['manager'], allowUserYield: false }),
        armId: 'jev-persona',
        lang: 'fr',
      },
      {
        ...entry('speak', 'TT-S5', { acceptablePersonaIds: ['manager'], allowUserYield: false }),
        armId: 'jev-central',
        lang: 'fr',
      },
    ])
    expect(readings.map((reading) => `${reading.armId}/${reading.lang}/${reading.family}`)).toEqual(
      ['jev-central/en/TT-S6', 'jev-central/fr/TT-S5', 'jev-persona/fr/TT-S5'],
    )
  })
})
