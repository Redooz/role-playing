import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRoutingContext } from '@rp/routing-policy'
import { describe, expect, it } from 'vitest'
import { JevUnavailableError } from '../jev/errors.js'
import type { RoutingCentralObservation, RoutingPersonaObservation } from '../jev/routing.js'
import type { JevBatchSuccess } from '../jev/types.js'
import {
  DETERMINISTIC_POLICY_VERSION,
  JEV_CENTRAL_POLICY_VERSION,
  JEV_PERSONA_POLICY_VERSION,
  routingArtifact,
  routingDecisionArtifactSchema,
  runDeterministicRoutingReplay,
  runJevRoutingReplay,
  writeRoutingArtifacts,
} from './routing.js'

const context = parseRoutingContext({
  decisionId: 'decision-1',
  turnId: 'turn-1',
  lang: 'en',
  coveredObjectiveIds: [],
  personas: [
    {
      id: 'manager',
      displayName: 'Katherine Brooks',
      aliases: ['Katherine'],
      role: 'manager',
      objectives: [{ id: 'deadline', description: 'Agree a deadline.', keywords: ['deadline'] }],
    },
    {
      id: 'peer',
      displayName: 'Sam Carter',
      aliases: ['Sam'],
      role: 'peer colleague',
      objectives: [{ id: 'handoff', description: 'Confirm handoff.', keywords: ['handoff'] }],
    },
    {
      id: 'client',
      displayName: 'Julian Moore',
      aliases: ['Julian'],
      role: 'external client',
      objectives: [{ id: 'contract', description: 'Resolve renewal.', keywords: ['renewal'] }],
    },
  ],
  transcript: [
    { speaker: { kind: 'persona', personaId: 'manager' }, text: 'We need a date.' },
    { speaker: { kind: 'user' }, text: 'Sam, can you confirm the handoff?' },
  ],
})

function success(answers: JevBatchSuccess['answers'], questionIds: string[]): JevBatchSuccess {
  const response = {
    model: 'typesafe/jev-1.14-20261014',
    answers,
    usage: { input_tokens: 10, output_tokens: 2 },
  }
  return {
    ok: true,
    questionIds,
    request: { model: 'typesafe/jev-1.14', state: {}, questions: {} },
    response,
    raw: response,
    answers,
    distributions: {},
    usage: response.usage,
    servedModel: response.model,
    cache: { key: 'a'.repeat(64), hit: false, stored: true },
  }
}

function central(value: number, selectedPersonaId = 'peer'): RoutingCentralObservation {
  const exact = success(
    {
      anyone_should_contribute: { type: 'noul', noul: value },
      best_next_speaker: {
        type: 'choice',
        choice: selectedPersonaId,
        probabilities: { manager: 0.1, peer: 0.8, client: 0.1 },
      },
    },
    ['anyone_should_contribute', 'best_next_speaker'],
  )
  return { judgment: { anyoneWarranted: value, selectedPersonaId }, exact }
}

function personaJudgments(
  overrides: Partial<RoutingPersonaObservation['judgments']> = {},
): RoutingPersonaObservation['judgments'] {
  return {
    directlyAddressed: 0,
    hasRelevantContribution: 0,
    addsUncoveredInformation: 0,
    hasUnmetRelevantObjective: 0,
    pauseWouldBenefitUser: 1,
    ...overrides,
  }
}

function personaObservation(
  judgments: RoutingPersonaObservation['judgments'],
): RoutingPersonaObservation {
  return {
    judgments,
    exact: success(
      {
        directly_addressed: { type: 'noul', noul: judgments.directlyAddressed },
        has_relevant_contribution: { type: 'noul', noul: judgments.hasRelevantContribution },
        adds_uncovered_information: { type: 'noul', noul: judgments.addsUncoveredInformation },
        has_unmet_relevant_objective: { type: 'noul', noul: judgments.hasUnmetRelevantObjective },
        pause_would_benefit_user: { type: 'noul', noul: judgments.pauseWouldBenefitUser },
      },
      [
        'directly_addressed',
        'has_relevant_contribution',
        'adds_uncovered_information',
        'has_unmet_relevant_objective',
        'pause_would_benefit_user',
      ],
    ),
  }
}

describe('runDeterministicRoutingReplay', () => {
  it('returns a speak decision and deterministic observation', () => {
    const result = runDeterministicRoutingReplay(context, 'central_selection', 1)
    expect(result.ok).toBe(true)
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'peer' })
    expect(result.decision.policyVersion).toBe(DETERMINISTIC_POLICY_VERSION)
    expect(result.observation).toEqual({ kind: 'deterministic' })
  })

  it('returns an all-declined decision when no one contributes', () => {
    const noContribution = parseRoutingContext({
      ...context,
      transcript: [{ speaker: { kind: 'user' }, text: 'Thanks, noted.' }],
    })
    const result = runDeterministicRoutingReplay(noContribution, 'persona_requests', 1)
    expect(result.decision.outcome).toEqual({ kind: 'user_yield', reason: 'all_declined' })
  })
})

describe('runJevRoutingReplay central', () => {
  it('uses the Jev-selected speaker when contribution is warranted', async () => {
    const judge = {
      async judgeCentral() {
        return { ok: true as const, observation: central(0.9, 'client') }
      },
      async judgePersona() {
        throw new Error('unexpected')
      },
    }
    const result = await runJevRoutingReplay(context, 'central_selection', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'client' })
    expect(result.decision.policyVersion).toBe(JEV_CENTRAL_POLICY_VERSION)
    expect(result.observation.kind).toBe('jev')
  })

  it('yields all_declined when Jev says no one contributes', async () => {
    const judge = {
      async judgeCentral() {
        return { ok: true as const, observation: central(0.1) }
      },
      async judgePersona() {
        throw new Error('unexpected')
      },
    }
    const result = await runJevRoutingReplay(context, 'central_selection', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result.ok && result.decision.outcome).toEqual({
      kind: 'user_yield',
      reason: 'all_declined',
    })
  })

  it('falls back deterministically when the contribution Noul is unsettled', async () => {
    const judge = {
      async judgeCentral() {
        return { ok: true as const, observation: central(0.5) }
      },
      async judgePersona() {
        throw new Error('unexpected')
      },
    }
    const result = await runJevRoutingReplay(context, 'central_selection', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision.fallback).toEqual({ kind: 'deterministic', cause: 'unsettled' })
    expect(result.decision.judgmentSource).toBe('deterministic')
  })

  it('rejects a non-positive deadline instead of silently disabling fallback', async () => {
    const judge = {
      async judgeCentral() {
        return { ok: true as const, observation: central(0.9) }
      },
      async judgePersona() {
        throw new Error('unexpected')
      },
    }
    for (const deadlineMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        runJevRoutingReplay(context, 'central_selection', judge, { seed: 1, deadlineMs }),
      ).rejects.toThrow(/positive finite/i)
    }
  })

  it('uses the shared Noul bounds at exactly 0.3 and 0.7', async () => {
    for (const [value, expectedKind, expectedReason] of [
      [0.3, 'user_yield', 'all_declined'],
      [0.7, 'speak', undefined],
    ] as const) {
      const judge = {
        async judgeCentral() {
          return { ok: true as const, observation: central(value) }
        },
        async judgePersona() {
          throw new Error('unexpected')
        },
      }
      const result = await runJevRoutingReplay(context, 'central_selection', judge, {
        seed: 1,
        deadlineMs: 1000,
      })
      expect(result.ok && result.decision.outcome.kind).toBe(expectedKind)
      if (expectedReason !== undefined) {
        expect(result.ok && result.decision.outcome).toMatchObject({ reason: expectedReason })
      }
    }
  })

  it('returns infrastructure-incomplete for a provider failure', async () => {
    const error = new JevUnavailableError('down', { reason: 'network' })
    const judge = {
      async judgeCentral() {
        return { ok: false as const, error, questionIds: ['a'] }
      },
      async judgePersona() {
        throw new Error('unexpected')
      },
    }
    const result = await runJevRoutingReplay(context, 'central_selection', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result).toMatchObject({ ok: false, kind: 'infrastructure_incomplete', error: 'down' })
  })
})

describe('runJevRoutingReplay persona requests', () => {
  it('derives requests from the five Jev judgments and ranks a winner', async () => {
    const judge = {
      async judgeCentral() {
        throw new Error('unexpected')
      },
      async judgePersona(_context: typeof context, persona: { id: string }) {
        return {
          ok: true as const,
          observation:
            persona.id === 'peer'
              ? personaObservation(
                  personaJudgments({
                    directlyAddressed: 0.9,
                    hasRelevantContribution: 0.9,
                    addsUncoveredInformation: 0.8,
                    pauseWouldBenefitUser: 0.1,
                  }),
                )
              : personaObservation(personaJudgments()),
        }
      },
    }
    const result = await runJevRoutingReplay(context, 'persona_requests', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'peer' })
    expect(result.decision.policyVersion).toBe(JEV_PERSONA_POLICY_VERSION)
  })

  it('falls back when any persona judgment is unsettled', async () => {
    const judge = {
      async judgeCentral() {
        throw new Error('unexpected')
      },
      async judgePersona(_context: typeof context, persona: { id: string }) {
        return {
          ok: true as const,
          observation:
            persona.id === 'client'
              ? personaObservation(
                  personaJudgments({
                    hasRelevantContribution: 0.5,
                    pauseWouldBenefitUser: 0,
                  }),
                )
              : personaObservation(personaJudgments()),
        }
      },
    }
    const result = await runJevRoutingReplay(context, 'persona_requests', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision.fallback).toEqual({ kind: 'deterministic', cause: 'unsettled' })
  })

  it('uses the timeout fallback without turning it into a model no', async () => {
    const judge = {
      async judgeCentral() {
        throw new Error('unexpected')
      },
      async judgePersona() {
        await new Promise(() => {})
        throw new Error('unreachable')
      },
    }
    const result = await runJevRoutingReplay(context, 'persona_requests', judge, {
      seed: 1,
      deadlineMs: 5,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.observation).toEqual({ kind: 'timeout' })
    expect(result.decision.fallback).toEqual({ kind: 'deterministic', cause: 'timeout' })
    expect(result.decision.judgmentSource).toBe('deterministic')
  })

  it('maps a timed-out all-decline fallback to policy_timeout', async () => {
    const noContribution = parseRoutingContext({
      ...context,
      transcript: [{ speaker: { kind: 'user' }, text: 'Thanks, noted.' }],
    })
    const judge = {
      async judgeCentral() {
        throw new Error('unexpected')
      },
      async judgePersona() {
        await new Promise(() => {})
        throw new Error('unreachable')
      },
    }
    const result = await runJevRoutingReplay(noContribution, 'persona_requests', judge, {
      seed: 1,
      deadlineMs: 5,
    })
    expect(result.ok && result.decision.outcome).toEqual({
      kind: 'user_yield',
      reason: 'policy_timeout',
    })
  })

  it('turns an unexpected rejection into incomplete, not a decision', async () => {
    const judge = {
      async judgeCentral() {
        throw new Error('unexpected')
      },
      async judgePersona() {
        throw new Error('boom')
      },
    }
    const result = await runJevRoutingReplay(context, 'persona_requests', judge, {
      seed: 1,
      deadlineMs: 1000,
    })
    expect(result).toMatchObject({
      ok: false,
      kind: 'infrastructure_incomplete',
      error: 'boom',
    })
  })
})

describe('routing artifacts', () => {
  it('wraps a success as a restricted exact record', () => {
    const result = runDeterministicRoutingReplay(context, 'central_selection', 1)
    const artifact = routingArtifact(context, result, {
      trialId: '0:en:decision-1',
      taskId: 'decision-1',
      arm: { topology: 'central_selection', judgmentSource: 'deterministic' },
    })
    expect(artifact).toMatchObject({
      kind: 'routing.decision',
      contentClass: 'restricted',
      outcome: 'completed',
      taskId: 'decision-1',
      arm: { topology: 'central_selection', judgmentSource: 'deterministic' },
    })
    expect(artifact.contextHash).toMatch(/^[0-9a-f]{64}$/)
    expect(routingDecisionArtifactSchema.safeParse(artifact).success).toBe(true)
  })

  it('records a timeout as incomplete while preserving the fallback decision for audit', async () => {
    const timeout = await runJevRoutingReplay(
      context,
      'persona_requests',
      {
        async judgeCentral() {
          throw new Error('unexpected')
        },
        async judgePersona() {
          await new Promise(() => {})
          throw new Error('unreachable')
        },
      },
      { seed: 1, deadlineMs: 5 },
    )
    if (!timeout.ok) throw new Error('expected timeout result')
    const artifact = routingArtifact(context, timeout, {
      trialId: '0:en:decision-1',
      taskId: 'decision-1',
      arm: { topology: 'persona_requests', judgmentSource: 'jev' },
    })
    expect(artifact).toMatchObject({
      outcome: 'infrastructure_incomplete',
      observation: { kind: 'timeout' },
      error: 'routing policy timed out; deterministic fallback preserved for audit only',
    })
    expect(artifact.decision).toBeDefined()
  })

  it('records an incomplete failure without a decision', () => {
    const artifact = routingArtifact(
      context,
      {
        ok: false,
        kind: 'infrastructure_incomplete',
        error: 'down',
        questionIds: ['q'],
        policyLatencyMs: 9,
      },
      {
        trialId: '0:en:decision-1',
        taskId: 'decision-1',
        arm: { topology: 'persona_requests', judgmentSource: 'jev' },
      },
    )
    expect(artifact).toMatchObject({
      outcome: 'infrastructure_incomplete',
      observation: { kind: 'none' },
      error: 'down',
    })
    expect(artifact).not.toHaveProperty('decision')
  })

  it('appends restricted JSONL records instead of overwriting earlier decisions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'routing-artifacts-'))
    try {
      const artifact = routingArtifact(
        context,
        runDeterministicRoutingReplay(context, 'central_selection', 1),
        {
          trialId: '0:en:decision-1',
          taskId: 'decision-1',
          arm: { topology: 'central_selection', judgmentSource: 'deterministic' },
        },
      )
      const path = join(directory, 'routing', 'decisions.jsonl')
      await writeRoutingArtifacts(path, [artifact])
      await writeRoutingArtifacts(path, [artifact])
      const lines = (await readFile(path, 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!)).toMatchObject({
        kind: 'routing.decision',
        contentClass: 'restricted',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('preserves an empty failure message with a non-empty artifact detail', () => {
    const artifact = routingArtifact(
      context,
      {
        ok: false,
        kind: 'infrastructure_incomplete',
        error: '   ',
        questionIds: [],
        policyLatencyMs: 1,
      },
      {
        trialId: '0:en:decision-1',
        taskId: 'decision-1',
        arm: { topology: 'central_selection', judgmentSource: 'jev' },
      },
    )
    expect(artifact.error).toBe('routing policy failed without a message')
  })
})
