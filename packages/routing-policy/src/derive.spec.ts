import { describe, expect, it } from 'vitest'
import type { RoutingJudgments } from './schemas.js'
import { makeContext } from './fixtures.js'
import {
  NOUL_NO,
  NOUL_YES,
  derivePersonaDecision,
  deriveRequests,
  deriveTurnRequest,
  deterministicJudgmentsByPersona,
} from './derive.js'

function judgments(overrides: Partial<RoutingJudgments> = {}): RoutingJudgments {
  return {
    directlyAddressed: 0,
    hasRelevantContribution: 0,
    addsUncoveredInformation: 0,
    hasUnmetRelevantObjective: 0,
    pauseWouldBenefitUser: 0,
    ...overrides,
  }
}

describe('derivePersonaDecision', () => {
  it('declines when the user should be allowed to pause', () => {
    expect(derivePersonaDecision(judgments({ pauseWouldBenefitUser: NOUL_YES }))).toEqual({
      personaId: '',
      kind: 'decline',
      reason: 'pause_would_benefit_user',
    })
  })

  it('lets direct address override a pause signal', () => {
    expect(
      derivePersonaDecision(
        judgments({
          directlyAddressed: NOUL_YES,
          pauseWouldBenefitUser: NOUL_YES,
        }),
      ),
    ).toEqual({ personaId: '', kind: 'request' })
  })

  it('requests for a relevant additive contribution', () => {
    expect(
      derivePersonaDecision(
        judgments({
          hasRelevantContribution: NOUL_YES,
          addsUncoveredInformation: NOUL_YES,
        }),
      ),
    ).toEqual({ personaId: '', kind: 'request' })
  })

  it('requests for a relevant unmet objective', () => {
    expect(
      derivePersonaDecision(
        judgments({
          hasRelevantContribution: NOUL_YES,
          hasUnmetRelevantObjective: NOUL_YES,
        }),
      ),
    ).toEqual({ personaId: '', kind: 'request' })
  })

  it('declines a relevant contribution that adds nothing and meets no objective', () => {
    expect(
      derivePersonaDecision(
        judgments({
          hasRelevantContribution: NOUL_YES,
        }),
      ),
    ).toEqual({ personaId: '', kind: 'decline', reason: 'no_contribution' })
  })

  it('declines when every signal is clearly absent', () => {
    expect(derivePersonaDecision(judgments())).toEqual({
      personaId: '',
      kind: 'decline',
      reason: 'no_contribution',
    })
  })

  it('declines despite an uncovered signal when relevance is clearly absent', () => {
    expect(
      derivePersonaDecision(
        judgments({
          addsUncoveredInformation: NOUL_YES,
          hasUnmetRelevantObjective: NOUL_YES,
        }),
      ),
    ).toEqual({ personaId: '', kind: 'decline', reason: 'no_contribution' })
  })

  it.each([
    ['direct address', judgments({ directlyAddressed: 0.5, pauseWouldBenefitUser: 0.5 })],
    ['pause', judgments({ pauseWouldBenefitUser: 0.5 })],
    ['relevance', judgments({ hasRelevantContribution: 0.5 })],
    [
      'adds information',
      judgments({ hasRelevantContribution: NOUL_YES, addsUncoveredInformation: 0.5 }),
    ],
    [
      'unmet objective',
      judgments({ hasRelevantContribution: NOUL_YES, hasUnmetRelevantObjective: 0.5 }),
    ],
  ])('returns unsettled when %s is between the lines', (_label, input) => {
    expect(derivePersonaDecision(input)).toEqual({ personaId: '', kind: 'unsettled' })
  })

  it.each([
    ['just above no', 0.301],
    ['just below yes', 0.699],
  ])('keeps the unsettled band open at %s (%s)', (_label, value) => {
    expect(derivePersonaDecision(judgments({ hasRelevantContribution: value })).kind).toBe(
      'unsettled',
    )
  })

  it('treats the lower bound itself as a clear no', () => {
    expect(derivePersonaDecision(judgments({ hasRelevantContribution: NOUL_NO })).kind).toBe(
      'decline',
    )
  })

  it('treats exactly 0.3 as no and exactly 0.7 as yes', () => {
    expect(
      derivePersonaDecision(
        judgments({
          hasRelevantContribution: NOUL_YES,
          addsUncoveredInformation: NOUL_YES,
        }),
      ).kind,
    ).toBe('request')
    expect(derivePersonaDecision(judgments({ hasRelevantContribution: NOUL_NO })).kind).toBe(
      'decline',
    )
  })
})

describe('deriveTurnRequest', () => {
  it('fills all wire fields from state and judgments', () => {
    const context = makeContext()
    const request = deriveTurnRequest(
      context,
      context.personas[1]!,
      judgments({
        directlyAddressed: 1,
        hasRelevantContribution: 1,
        addsUncoveredInformation: 1,
      }),
    )
    expect(request).toEqual({
      turnId: 'turn-1',
      personaId: 'peer',
      action: 'speak',
      urgency: 1,
      confidence: 1,
      addressedByUser: true,
      objectiveRelevance: 1,
    })
  })

  it('uses the maximum positive signal as confidence', () => {
    const context = makeContext({ lastUser: 'Tell me about the deadline.' })
    const request = deriveTurnRequest(
      context,
      context.personas[0]!,
      judgments({
        hasRelevantContribution: 0.7,
        hasUnmetRelevantObjective: 0.4,
        addsUncoveredInformation: 0.2,
      }),
    )
    expect(request.confidence).toBe(0.7)
  })
})

describe('deriveRequests', () => {
  it('partitions requests, declines and unsettled personas', () => {
    const context = makeContext()
    const result = deriveRequests(
      context,
      new Map([
        ['manager', judgments({ pauseWouldBenefitUser: 1 })],
        ['peer', judgments({ directlyAddressed: 1, hasRelevantContribution: 1 })],
        ['client', judgments({ hasRelevantContribution: 0.5 })],
      ]),
    )
    expect(result.requests.map((request) => request.personaId)).toEqual(['peer'])
    expect(result.declines).toEqual([{ personaId: 'manager', reason: 'pause_would_benefit_user' }])
    expect(result.unsettled).toEqual(['client'])
    expect(result.judged).toHaveLength(3)
  })

  it('preserves the persona decision on each judged entry', () => {
    const context = makeContext()
    const result = deriveRequests(
      context,
      new Map(context.personas.map((persona) => [persona.id, judgments()])),
    )
    expect(result.judged.map((entry) => entry.decision.personaId)).toEqual([
      'manager',
      'peer',
      'client',
    ])
  })

  it('throws when a persona judgment is missing', () => {
    expect(() => deriveRequests(makeContext(), new Map())).toThrow(
      /missing judgments for eligible persona/i,
    )
  })
})

describe('deterministicJudgmentsByPersona', () => {
  it('returns one entry per eligible persona', () => {
    const map = deterministicJudgmentsByPersona(makeContext())
    expect([...map.keys()]).toEqual(['manager', 'peer', 'client'])
    expect(map.get('peer')?.directlyAddressed).toBe(1)
  })
})
