import { describe, expect, it } from 'vitest'
import { makeContext } from './fixtures.js'
import {
  DETERMINISTIC_POLICY_VERSION,
  ROUTING_DECISION_SCHEMA_VERSION,
  parseRoutingContext,
  parseRoutingDecision,
  type RoutingDecision,
} from './schemas.js'

const judgments = {
  directlyAddressed: 1,
  hasRelevantContribution: 1,
  addsUncoveredInformation: 1,
  hasUnmetRelevantObjective: 1,
  pauseWouldBenefitUser: 0,
}

function validDecision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    schemaVersion: ROUTING_DECISION_SCHEMA_VERSION,
    decisionId: 'decision-1',
    turnId: 'turn-1',
    lang: 'en',
    topology: 'central_selection',
    judgmentSource: 'deterministic',
    policyVersion: DETERMINISTIC_POLICY_VERSION,
    eligiblePersonaIds: ['manager', 'peer'],
    outcome: {
      kind: 'speak',
      personaId: 'peer',
      request: {
        turnId: 'turn-1',
        personaId: 'peer',
        action: 'speak',
        urgency: 1,
        confidence: 1,
        addressedByUser: true,
        objectiveRelevance: 1,
      },
    },
    requests: [
      {
        turnId: 'turn-1',
        personaId: 'peer',
        action: 'speak',
        urgency: 1,
        confidence: 1,
        addressedByUser: true,
        objectiveRelevance: 1,
      },
    ],
    declines: [{ personaId: 'manager', reason: 'no_contribution' }],
    unsettledPersonas: [],
    judgments: { manager: judgments, peer: judgments },
    fallback: { kind: 'none' },
    ...overrides,
  }
}

describe('routingContextSchema', () => {
  it('accepts a valid context', () => {
    expect(makeContext().personas).toHaveLength(3)
  })

  it('rejects an empty transcript', () => {
    expect(() => makeContext({ transcript: [] })).toThrow(/transcript/i)
  })

  it('requires a committed user utterance last', () => {
    expect(() =>
      makeContext({
        transcript: [{ speaker: { kind: 'persona', personaId: 'peer' }, text: 'Hello' }],
      }),
    ).toThrow(/committed user utterance/i)
  })

  it('rejects fewer than two personas', () => {
    expect(() => makeContext({ personas: [makeContext().personas[0]!] })).toThrow(/personas/i)
  })

  it('rejects more than three personas', () => {
    const persona = makeContext().personas[0]!
    expect(() => makeContext({ personas: [persona, persona, persona, persona] })).toThrow(
      /personas/i,
    )
  })

  it('rejects duplicate persona ids', () => {
    const [manager] = makeContext().personas
    expect(() => makeContext({ personas: [manager!, manager!] })).toThrow(/duplicate persona id/i)
  })

  it('rejects ambiguous display names and aliases after normalisation', () => {
    const [manager] = makeContext().personas
    const shadow = {
      ...manager!,
      id: 'other',
      displayName: 'KATE',
      aliases: [],
    }
    expect(() => makeContext({ personas: [manager!, shadow] })).toThrow(/ambiguous/i)
  })

  it('rejects duplicate objective ids', () => {
    const [manager, peer] = makeContext().personas
    expect(() =>
      makeContext({
        personas: [
          manager!,
          {
            ...peer!,
            objectives: [{ id: 'deadline', description: 'Duplicate.', keywords: ['same'] }],
          },
        ],
      }),
    ).toThrow(/duplicate objective id/i)
  })

  it('rejects an unknown covered objective', () => {
    expect(() => makeContext({ coveredObjectiveIds: ['missing'] })).toThrow(
      /not declared by an eligible persona/i,
    )
  })

  it('rejects a transcript persona who is not eligible', () => {
    expect(() =>
      makeContext({
        transcript: [
          { speaker: { kind: 'persona', personaId: 'ghost' }, text: 'Boo' },
          { speaker: { kind: 'user' }, text: 'Who said that?' },
        ],
      }),
    ).toThrow(/unknown transcript persona/i)
  })
})

describe('routingDecisionSchema', () => {
  it('accepts a valid speak decision', () => {
    expect(parseRoutingDecision(validDecision()).outcome.kind).toBe('speak')
  })

  it('accepts an all-declined yield with no requests', () => {
    const decision = parseRoutingDecision(
      validDecision({
        eligiblePersonaIds: ['manager', 'peer'],
        outcome: { kind: 'user_yield', reason: 'all_declined' },
        requests: [],
        declines: [
          { personaId: 'manager', reason: 'no_contribution' },
          { personaId: 'peer', reason: 'pause_would_benefit_user' },
        ],
        fallback: { kind: 'none' },
      }),
    )
    expect(decision.outcome).toEqual({ kind: 'user_yield', reason: 'all_declined' })
  })

  it('rejects duplicate eligible ids', () => {
    expect(() =>
      parseRoutingDecision(validDecision({ eligiblePersonaIds: ['peer', 'peer'] })),
    ).toThrow(/eligible persona ids must be unique/i)
  })

  it('rejects judgments that omit an eligible persona', () => {
    expect(() => parseRoutingDecision(validDecision({ judgments: { peer: judgments } }))).toThrow(
      /judgments must cover exactly/i,
    )
  })

  it('rejects judgments for an ineligible persona', () => {
    expect(() =>
      parseRoutingDecision(
        validDecision({ judgments: { ...validDecision().judgments, ghost: judgments } }),
      ),
    ).toThrow(/judgments must cover exactly/i)
  })

  it('rejects a request for an ineligible persona', () => {
    const request = validDecision().requests[0]!
    expect(() =>
      parseRoutingDecision(validDecision({ requests: [{ ...request, personaId: 'client' }] })),
    ).toThrow(/not eligible/i)
  })

  it('rejects duplicate requests', () => {
    const request = validDecision().requests[0]!
    expect(() => parseRoutingDecision(validDecision({ requests: [request, request] }))).toThrow(
      /duplicate request/i,
    )
  })

  it('rejects interject requests in M3a', () => {
    const request = validDecision().requests[0]!
    expect(() =>
      parseRoutingDecision(
        validDecision({
          requests: [{ ...request, action: 'interject', targetGrantId: 'grant-1' }],
        }),
      ),
    ).toThrow(/speak requests only/i)
  })

  it('rejects a request turn id that differs from the decision', () => {
    const request = validDecision().requests[0]!
    expect(() =>
      parseRoutingDecision(validDecision({ requests: [{ ...request, turnId: 'turn-2' }] })),
    ).toThrow(/request turnId does not match/i)
  })

  it('rejects duplicate declines', () => {
    expect(() =>
      parseRoutingDecision(
        validDecision({
          declines: [
            { personaId: 'manager', reason: 'no_contribution' },
            { personaId: 'manager', reason: 'pause_would_benefit_user' },
          ],
        }),
      ),
    ).toThrow(/duplicate decline/i)
  })

  it('rejects an ineligible decline', () => {
    expect(() =>
      parseRoutingDecision(
        validDecision({ declines: [{ personaId: 'client', reason: 'no_contribution' }] }),
      ),
    ).toThrow(/not eligible/i)
  })

  it('rejects a persona that both requests and declines', () => {
    expect(() =>
      parseRoutingDecision(
        validDecision({
          declines: [
            { personaId: 'peer', reason: 'no_contribution' },
            { personaId: 'manager', reason: 'no_contribution' },
          ],
        }),
      ),
    ).toThrow(/cannot both request and decline/i)
  })

  it('rejects a persona with no request, decline or unsettled marker', () => {
    expect(() => parseRoutingDecision(validDecision({ declines: [] }))).toThrow(
      /has no request, decline or unsettled marker/i,
    )
  })

  it('accepts an unsettled marker in place of a request or decline', () => {
    expect(
      parseRoutingDecision(
        validDecision({
          outcome: { kind: 'user_yield', reason: 'unsettled' },
          requests: [],
          declines: [{ personaId: 'manager', reason: 'no_contribution' }],
          unsettledPersonas: ['peer'],
          fallback: { kind: 'deterministic', cause: 'unsettled' },
        }),
      ).unsettledPersonas,
    ).toEqual(['peer'])
  })

  it('rejects an ineligible unsettled persona', () => {
    expect(() => parseRoutingDecision(validDecision({ unsettledPersonas: ['client'] }))).toThrow(
      /unsettled persona.*client.*not eligible/i,
    )
  })

  it('rejects duplicate unsettled personas', () => {
    expect(() =>
      parseRoutingDecision(validDecision({ unsettledPersonas: ['peer', 'peer'] })),
    ).toThrow(/duplicate unsettled persona/i)
  })

  it('rejects a persona that is both settled and unsettled', () => {
    expect(() => parseRoutingDecision(validDecision({ unsettledPersonas: ['peer'] }))).toThrow(
      /cannot be settled and unsettled at once/i,
    )
  })

  it('rejects a speaker with no derived request', () => {
    const request = validDecision().requests[0]!
    expect(() =>
      parseRoutingDecision(
        validDecision({
          outcome: {
            kind: 'speak',
            personaId: 'manager',
            request: { ...request, personaId: 'manager' },
          },
        }),
      ),
    ).toThrow(/selected speaker has no derived request/i)
  })

  it('rejects an outcome request for a different persona', () => {
    const request = validDecision().requests[0]!
    expect(() =>
      parseRoutingDecision(
        validDecision({
          outcome: {
            kind: 'speak',
            personaId: 'peer',
            request: { ...request, personaId: 'manager' },
          },
        }),
      ),
    ).toThrow(/names a different persona/i)
  })

  it('rejects all_declined when requests exist', () => {
    expect(() =>
      parseRoutingDecision(
        validDecision({ outcome: { kind: 'user_yield', reason: 'all_declined' } }),
      ),
    ).toThrow(/all_declined/i)
  })

  it('requires a fallback for timeout and unsettled yields', () => {
    expect(() =>
      parseRoutingDecision(
        validDecision({
          outcome: { kind: 'user_yield', reason: 'policy_timeout' },
          requests: [],
          declines: [
            { personaId: 'manager', reason: 'no_contribution' },
            { personaId: 'peer', reason: 'no_contribution' },
          ],
          fallback: { kind: 'none' },
        }),
      ),
    ).toThrow(/must declare a deterministic fallback/i)
  })

  it('accepts a timeout fallback only with policy_timeout', () => {
    expect(
      parseRoutingDecision(
        validDecision({
          outcome: { kind: 'user_yield', reason: 'policy_timeout' },
          requests: [],
          declines: [
            { personaId: 'manager', reason: 'no_contribution' },
            { personaId: 'peer', reason: 'no_contribution' },
          ],
          fallback: { kind: 'deterministic', cause: 'timeout' },
        }),
      ).outcome,
    ).toEqual({ kind: 'user_yield', reason: 'policy_timeout' })
  })

  it('accepts an unsettled fallback only with unsettled', () => {
    expect(
      parseRoutingDecision(
        validDecision({
          outcome: { kind: 'user_yield', reason: 'unsettled' },
          requests: [],
          declines: [
            { personaId: 'manager', reason: 'no_contribution' },
            { personaId: 'peer', reason: 'no_contribution' },
          ],
          fallback: { kind: 'deterministic', cause: 'unsettled' },
        }),
      ).outcome,
    ).toEqual({ kind: 'user_yield', reason: 'unsettled' })
  })

  it('rejects a fallback cause and yield reason mismatch', () => {
    expect(() =>
      parseRoutingDecision(
        validDecision({
          outcome: { kind: 'user_yield', reason: 'policy_timeout' },
          requests: [],
          declines: [
            { personaId: 'manager', reason: 'no_contribution' },
            { personaId: 'peer', reason: 'no_contribution' },
          ],
          fallback: { kind: 'deterministic', cause: 'unsettled' },
        }),
      ),
    ).toThrow(/deterministic unsettled fallback must yield/i)
  })

  it('accepts a deterministic fallback that selects a speaker', () => {
    expect(
      parseRoutingDecision(validDecision({ fallback: { kind: 'deterministic', cause: 'timeout' } }))
        .outcome.kind,
    ).toBe('speak')
  })
})

describe('parseRoutingContext', () => {
  it('returns the parsed value', () => {
    expect(parseRoutingContext(makeContext()).decisionId).toBe('decision-1')
  })
})
