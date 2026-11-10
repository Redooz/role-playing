import { describe, expect, it } from 'vitest'
import { makeContext } from './fixtures.js'
import {
  buildDeterministicDecision,
  decideDeterministicCentral,
  decideDeterministicPersonaRequests,
} from './deterministic.js'
import { DETERMINISTIC_POLICY_VERSION, type RoutingJudgments } from './schemas.js'

const options = { seed: 42 }

describe('decideDeterministicCentral', () => {
  it('selects the directly addressed persona', () => {
    const result = decideDeterministicCentral(makeContext(), options)
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'peer' })
    expect(result.decision.topology).toBe('central_selection')
    expect(result.decision.judgmentSource).toBe('deterministic')
    expect(result.decision.policyVersion).toBe(DETERMINISTIC_POLICY_VERSION)
  })

  it('selects an objective-relevant persona without direct address', () => {
    const result = decideDeterministicCentral(
      makeContext({ lastUser: 'What deadline works?' }),
      options,
    )
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'manager' })
  })

  it('yields to the learner when no persona has a contribution', () => {
    const result = decideDeterministicCentral(makeContext({ lastUser: 'Hello there.' }), options)
    expect(result.decision.outcome).toEqual({ kind: 'user_yield', reason: 'all_declined' })
    expect(result.decision.requests).toEqual([])
    expect(result.decision.fallback).toEqual({ kind: 'none' })
  })

  it('yields when all matching information is already covered', () => {
    const result = decideDeterministicCentral(
      makeContext({ lastUser: 'Can you confirm the handoff?', coveredObjectiveIds: ['handoff'] }),
      options,
    )
    expect(result.decision.outcome).toEqual({ kind: 'user_yield', reason: 'all_declined' })
  })

  it('derives one request per requesting persona and one decline for the rest', () => {
    const result = decideDeterministicCentral(
      makeContext({ lastUser: 'Sam, what is the deadline?' }),
      options,
    )
    expect(result.decision.requests.map((request) => request.personaId)).toEqual([
      'peer',
      'manager',
    ])
    expect(result.decision.declines).toEqual([
      { personaId: 'client', reason: 'pause_would_benefit_user' },
    ])
  })

  it('makes the outcome point at the winner request', () => {
    const result = decideDeterministicCentral(makeContext(), options)
    if (result.decision.outcome.kind !== 'speak') throw new Error('expected a speaker')
    expect(result.decision.outcome.request).toEqual(result.decision.requests[0])
  })

  it('returns one judgment entry per eligible persona', () => {
    const result = decideDeterministicCentral(makeContext(), options)
    expect(Object.keys(result.decision.judgments).sort()).toEqual(['client', 'manager', 'peer'])
    expect(result.judged).toHaveLength(3)
  })

  it('is stable for the same seed and input', () => {
    const first = decideDeterministicCentral(makeContext(), options).decision
    const second = decideDeterministicCentral(makeContext(), options).decision
    expect(second).toEqual(first)
  })

  it('uses the seeded tie-break when public features tie', () => {
    const first = decideDeterministicCentral(
      makeContext({ lastUser: 'Katherine and Sam, can you both answer?' }),
      { seed: 1 },
    ).decision
    const second = decideDeterministicCentral(
      makeContext({ lastUser: 'Katherine and Sam, can you both answer?' }),
      { seed: 1 },
    ).decision
    expect(second.outcome).toEqual(first.outcome)
  })

  it('does not let prior coverage suppress direct address', () => {
    const result = decideDeterministicCentral(
      makeContext({
        lastUser: 'Sam, can you confirm the handoff?',
        coveredObjectiveIds: ['handoff'],
      }),
      options,
    )
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'peer' })
  })
})

describe('buildDeterministicDecision', () => {
  it('yields with declared fallback when a judgment is unsettled', () => {
    const context = makeContext()
    const uncertain: RoutingJudgments = {
      directlyAddressed: 0,
      hasRelevantContribution: 0.5,
      addsUncoveredInformation: 0,
      hasUnmetRelevantObjective: 0,
      pauseWouldBenefitUser: 0,
    }
    const result = buildDeterministicDecision(
      context,
      'central_selection',
      new Map(context.personas.map((persona) => [persona.id, uncertain])),
      options.seed,
    )
    expect(result.decision.outcome).toEqual({ kind: 'user_yield', reason: 'unsettled' })
    expect(result.decision.unsettledPersonas).toEqual(['manager', 'peer', 'client'])
    expect(result.decision.fallback).toEqual({ kind: 'deterministic', cause: 'unsettled' })
  })

  it('reports personas that settled as declines alongside an unsettled peer', () => {
    const context = makeContext()
    const judgmentsFor = (relevant: number): RoutingJudgments => ({
      directlyAddressed: 0,
      hasRelevantContribution: relevant,
      addsUncoveredInformation: 0,
      hasUnmetRelevantObjective: 0,
      pauseWouldBenefitUser: 0,
    })
    const result = buildDeterministicDecision(
      context,
      'persona_requests',
      new Map([
        ['manager', judgmentsFor(0)],
        ['peer', judgmentsFor(0.5)],
        ['client', judgmentsFor(0)],
      ]),
      options.seed,
    )
    expect(result.decision.declines.map((decline) => decline.personaId)).toEqual([
      'manager',
      'client',
    ])
    expect(result.decision.unsettledPersonas).toEqual(['peer'])
  })
})

describe('decideDeterministicPersonaRequests', () => {
  it('reaches the same winner through per-persona requests', () => {
    const central = decideDeterministicCentral(makeContext(), options)
    const perPersona = decideDeterministicPersonaRequests(makeContext(), options)
    expect(perPersona.decision.topology).toBe('persona_requests')
    expect(perPersona.decision.outcome).toEqual(central.decision.outcome)
  })

  it('keeps the central policy version', () => {
    expect(decideDeterministicPersonaRequests(makeContext(), options).decision.policyVersion).toBe(
      DETERMINISTIC_POLICY_VERSION,
    )
  })

  it('yields for all-decline contexts', () => {
    expect(
      decideDeterministicPersonaRequests(makeContext({ lastUser: 'Nothing relevant.' }), options)
        .decision.outcome,
    ).toEqual({ kind: 'user_yield', reason: 'all_declined' })
  })
})
