import { describe, expect, it } from 'vitest'
import { assembleRoutingDecision } from './assembly.js'
import { deriveRequests, deterministicJudgmentsByPersona } from './derive.js'
import { makeContext } from './fixtures.js'

function base() {
  const context = makeContext()
  const judgments = deterministicJudgmentsByPersona(context)
  const { requests, declines, unsettled } = deriveRequests(context, judgments)
  return {
    context,
    judgments: Object.fromEntries(judgments),
    requests,
    declines,
    unsettledPersonas: unsettled,
  }
}

describe('assembleRoutingDecision', () => {
  it('selects an existing request and preserves provenance', () => {
    const input = base()
    const decision = assembleRoutingDecision({
      ...input,
      topology: 'central_selection',
      judgmentSource: 'deterministic',
      policyVersion: 'det-v1',
      selectedPersonaId: 'peer',
      fallback: { kind: 'none' },
    })
    expect(decision.outcome).toMatchObject({ kind: 'speak', personaId: 'peer' })
    expect(decision).toMatchObject({
      topology: 'central_selection',
      judgmentSource: 'deterministic',
      policyVersion: 'det-v1',
      fallback: { kind: 'none' },
    })
    // Exactly one judgment record is written: the feature judgments here.
    expect(decision).not.toHaveProperty('moveJudgments')
    if (decision.outcome.kind === 'speak') {
      expect(decision.outcome.request.personaId).toBe('peer')
    }
  })

  it('yields all_declined when no speaker or request is selected and no fallback fired', () => {
    const input = base()
    expect(
      assembleRoutingDecision({
        ...input,
        requests: [],
        declines: input.context.personas.map((persona) => ({
          personaId: persona.id,
          reason: 'no_contribution' as const,
        })),
        topology: 'persona_requests',
        judgmentSource: 'deterministic',
        policyVersion: 'det-v1',
        fallback: { kind: 'none' },
      }).outcome,
    ).toEqual({ kind: 'user_yield', reason: 'all_declined' })
  })

  it('rejects an all_declined decision while requests exist', () => {
    const input = base()
    expect(() =>
      assembleRoutingDecision({
        ...input,
        topology: 'persona_requests',
        judgmentSource: 'deterministic',
        policyVersion: 'det-v1',
        fallback: { kind: 'none' },
      }),
    ).toThrow(/while derived requests exist/i)
  })

  it('maps a timeout fallback yield to policy_timeout', () => {
    const input = base()
    expect(
      assembleRoutingDecision({
        ...input,
        topology: 'persona_requests',
        judgmentSource: 'deterministic',
        policyVersion: 'det-v1',
        fallback: { kind: 'deterministic', cause: 'timeout' },
      }).outcome,
    ).toEqual({ kind: 'user_yield', reason: 'policy_timeout' })
  })

  it('maps an unsettled fallback yield to unsettled', () => {
    const input = base()
    expect(
      assembleRoutingDecision({
        ...input,
        topology: 'central_selection',
        judgmentSource: 'deterministic',
        policyVersion: 'det-v1',
        fallback: { kind: 'deterministic', cause: 'unsettled' },
      }).outcome,
    ).toEqual({ kind: 'user_yield', reason: 'unsettled' })
  })

  it('yields when any persona is unsettled even if a speaker is selected', () => {
    const input = base()
    const client = input.context.personas.find((persona) => persona.id === 'client')!
    const clientRequest = {
      turnId: input.context.turnId,
      personaId: 'client',
      action: 'speak' as const,
      urgency: 0.5,
      confidence: 0.8,
      addressedByUser: false,
      objectiveRelevance: 0.5,
    }
    const decision = assembleRoutingDecision({
      ...input,
      topology: 'persona_requests',
      judgmentSource: 'deterministic',
      policyVersion: 'det-v1',
      requests: [...input.requests, clientRequest],
      declines: input.declines.filter((decline) => decline.personaId !== client.id),
      unsettledPersonas: ['client'],
      selectedPersonaId: 'peer',
      fallback: { kind: 'deterministic', cause: 'unsettled' },
    })
    expect(decision.outcome).toEqual({ kind: 'user_yield', reason: 'unsettled' })
    expect(decision.requests.map((request) => request.personaId)).not.toContain('client')
    expect(decision.declines.map((decline) => decline.personaId)).not.toContain('client')
  })

  it('rejects an unsettled decision without a deterministic fallback', () => {
    const input = base()
    expect(() =>
      assembleRoutingDecision({
        ...input,
        topology: 'persona_requests',
        judgmentSource: 'deterministic',
        policyVersion: 'det-v1',
        unsettledPersonas: ['client'],
        fallback: { kind: 'none' },
      }),
    ).toThrow(/requires a deterministic fallback/i)
  })

  it('maps timeout plus unsettled to policy_timeout', () => {
    const input = base()
    expect(
      assembleRoutingDecision({
        ...input,
        topology: 'persona_requests',
        judgmentSource: 'deterministic',
        policyVersion: 'det-v1',
        unsettledPersonas: ['client'],
        fallback: { kind: 'deterministic', cause: 'timeout' },
      }).outcome,
    ).toEqual({ kind: 'user_yield', reason: 'policy_timeout' })
  })

  it('records rubric v2 move judgments for a jev decision', () => {
    const input = base()
    const moveJudgments = {
      closingMove: 0.1,
      selfAnswer: 0.2,
      thinkingAloud: 0.1,
      sideComment: 0.2,
    } as const
    const decision = assembleRoutingDecision({
      context: input.context,
      topology: 'central_selection',
      judgmentSource: 'jev',
      policyVersion: 'm3d-jev-central-v2',
      moveJudgments: { scope: 'central', move: moveJudgments },
      requests: input.requests,
      declines: input.declines,
      unsettledPersonas: [],
      selectedPersonaId: 'peer',
      fallback: { kind: 'none' },
    })
    // And the other way round: a move-judgment decision omits the feature map.
    expect(decision).not.toHaveProperty('judgments')
    expect(decision.moveJudgments).toEqual({ scope: 'central', move: moveJudgments })
  })

  it('throws when the selected persona has no request', () => {
    const input = base()
    expect(() =>
      assembleRoutingDecision({
        ...input,
        topology: 'central_selection',
        judgmentSource: 'deterministic',
        policyVersion: 'det-v1',
        selectedPersonaId: 'manager',
        fallback: { kind: 'none' },
      }),
    ).toThrow(/no derived turn request/i)
  })
})
