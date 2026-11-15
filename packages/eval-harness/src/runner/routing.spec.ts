import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRoutingContext } from '@rp/routing-policy'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

/**
 * Two personas that tie on every comparator key, so the seeded hash decides.
 * `turn-2` + seed 1 ranks `manager` first; seed 2 ranks `peer` first.
 */
const tieContext = parseRoutingContext({
  decisionId: 'decision-tie',
  turnId: 'turn-2',
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
  ],
  transcript: [
    { speaker: { kind: 'user' }, text: 'Katherine and Sam, please confirm the deadline.' },
  ],
})

/** Freeze the monotonic clock so latency assertions are exact, not wall-clock flaky. */
function freezeClock(at = 1_000): void {
  vi.spyOn(performance, 'now').mockReturnValue(at)
}

afterEach(() => {
  vi.restoreAllMocks()
})

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

describe('runDeterministicRoutingReplay exact decisions', () => {
  it('keeps the seeded tie-break for both topologies', () => {
    for (const topology of ['central_selection', 'persona_requests'] as const) {
      const result = runDeterministicRoutingReplay(tieContext, topology, 1)
      expect(result.decision).toMatchObject({
        decisionId: 'decision-tie',
        turnId: 'turn-2',
        lang: 'en',
        topology,
        judgmentSource: 'deterministic',
        policyVersion: DETERMINISTIC_POLICY_VERSION,
        eligiblePersonaIds: ['manager', 'peer'],
        unsettledPersonas: [],
        fallback: { kind: 'none' },
      })
      expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'manager' })
      expect(result.observation).toStrictEqual({ kind: 'deterministic' })
    }
    expect(
      runDeterministicRoutingReplay(tieContext, 'persona_requests', 2).decision.outcome,
    ).toMatchObject({ kind: 'speak', personaId: 'peer' })
  })

  it('measures policy latency from the monotonic clock', () => {
    freezeClock(5_000)
    expect(runDeterministicRoutingReplay(context, 'central_selection', 1).policyLatencyMs).toBe(0)
  })
})

describe('runJevRoutingReplay exact records', () => {
  it('records a central failure with its question ids and no decision', async () => {
    freezeClock()
    const error = new JevUnavailableError('down', { reason: 'network' })
    const result = await runJevRoutingReplay(
      context,
      'central_selection',
      {
        async judgeCentral() {
          return { ok: false as const, error, questionIds: ['anyone_should_contribute'] }
        },
        async judgePersona() {
          throw new Error('unexpected')
        },
      },
      { seed: 1, deadlineMs: 1000 },
    )
    expect(result).toStrictEqual({
      ok: false,
      kind: 'infrastructure_incomplete',
      error: 'down',
      questionIds: ['anyone_should_contribute'],
      policyLatencyMs: 0,
    })
  })

  it('records a thrown judge as incomplete with no question ids', async () => {
    freezeClock()
    const result = await runJevRoutingReplay(
      context,
      'persona_requests',
      {
        async judgeCentral() {
          throw new Error('unexpected')
        },
        async judgePersona() {
          throw new Error('judge exploded')
        },
      },
      { seed: 1, deadlineMs: 1000 },
    )
    expect(result).toStrictEqual({
      ok: false,
      kind: 'infrastructure_incomplete',
      error: 'judge exploded',
      questionIds: [],
      policyLatencyMs: 0,
    })
  })

  it('records a persona failure with the failed batch question ids', async () => {
    freezeClock()
    const error = new JevUnavailableError('persona down', { reason: 'http', status: 502 })
    const result = await runJevRoutingReplay(
      context,
      'persona_requests',
      {
        async judgeCentral() {
          throw new Error('unexpected')
        },
        async judgePersona() {
          return { ok: false as const, error, questionIds: ['has_relevant_contribution'] }
        },
      },
      { seed: 1, deadlineMs: 1000 },
    )
    expect(result).toStrictEqual({
      ok: false,
      kind: 'infrastructure_incomplete',
      error: 'persona down',
      questionIds: ['has_relevant_contribution'],
      policyLatencyMs: 0,
    })
  })

  it('refuses a Jev-selected persona that is not eligible', async () => {
    freezeClock()
    const observation = central(0.9, 'ghost')
    const result = await runJevRoutingReplay(
      context,
      'central_selection',
      {
        async judgeCentral() {
          return { ok: true as const, observation }
        },
        async judgePersona() {
          throw new Error('unexpected')
        },
      },
      { seed: 1, deadlineMs: 1000 },
    )
    expect(result).toStrictEqual({
      ok: false,
      kind: 'infrastructure_incomplete',
      error: 'Jev selected a persona that is not eligible.',
      questionIds: ['anyone_should_contribute', 'best_next_speaker'],
      policyLatencyMs: 0,
    })
  })

  it('keeps a warranted central judgment out of the fallback count', async () => {
    freezeClock()
    const observation = central(0.7, 'peer')
    const result = await runJevRoutingReplay(
      context,
      'central_selection',
      {
        async judgeCentral() {
          return { ok: true as const, observation }
        },
        async judgePersona() {
          throw new Error('unexpected')
        },
      },
      { seed: 1, deadlineMs: 1000 },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policyLatencyMs).toBe(0)
    expect(result.decision).toStrictEqual({
      schemaVersion: '1.0.0',
      decisionId: 'decision-1',
      turnId: 'turn-1',
      lang: 'en',
      topology: 'central_selection',
      judgmentSource: 'jev',
      policyVersion: JEV_CENTRAL_POLICY_VERSION,
      eligiblePersonaIds: ['manager', 'peer', 'client'],
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
      declines: [
        { personaId: 'manager', reason: 'no_contribution' },
        { personaId: 'client', reason: 'no_contribution' },
      ],
      unsettledPersonas: [],
      judgments: {
        manager: {
          directlyAddressed: 0,
          hasRelevantContribution: 0,
          addsUncoveredInformation: 0,
          hasUnmetRelevantObjective: 0,
          pauseWouldBenefitUser: 1,
        },
        peer: {
          directlyAddressed: 1,
          hasRelevantContribution: 1,
          addsUncoveredInformation: 1,
          hasUnmetRelevantObjective: 0,
          pauseWouldBenefitUser: 0,
        },
        client: {
          directlyAddressed: 0,
          hasRelevantContribution: 0,
          addsUncoveredInformation: 0,
          hasUnmetRelevantObjective: 0,
          pauseWouldBenefitUser: 1,
        },
      },
      fallback: { kind: 'none' },
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
    })
    expect(result.observation).toStrictEqual({ kind: 'jev', central: observation })
  })

  it('falls back with the same seed when the central judgment is unsettled', async () => {
    freezeClock()
    const centralObservation = central(0.5, 'peer')
    const result = await runJevRoutingReplay(
      tieContext,
      'central_selection',
      {
        async judgeCentral() {
          return { ok: true as const, observation: centralObservation }
        },
        async judgePersona() {
          throw new Error('unexpected')
        },
      },
      { seed: 1, deadlineMs: 1000 },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policyLatencyMs).toBe(0)
    expect(result.decision).toMatchObject({
      topology: 'central_selection',
      judgmentSource: 'deterministic',
      policyVersion: DETERMINISTIC_POLICY_VERSION,
      fallback: { kind: 'deterministic', cause: 'unsettled' },
    })
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'manager' })
    expect(result.observation).toStrictEqual({ kind: 'jev', central: centralObservation })
  })

  it('falls back with the same seed when a persona judgment is unsettled', async () => {
    freezeClock()
    const observations = {
      manager: personaObservation(
        personaJudgments({ hasRelevantContribution: 0.5, pauseWouldBenefitUser: 0 }),
      ),
      peer: personaObservation(personaJudgments()),
    }
    const result = await runJevRoutingReplay(
      tieContext,
      'persona_requests',
      {
        async judgeCentral() {
          throw new Error('unexpected')
        },
        async judgePersona(_context, persona) {
          return { ok: true as const, observation: observations[persona.id as 'manager'] }
        },
      },
      { seed: 1, deadlineMs: 1000 },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policyLatencyMs).toBe(0)
    expect(result.decision).toMatchObject({
      topology: 'persona_requests',
      judgmentSource: 'deterministic',
      policyVersion: DETERMINISTIC_POLICY_VERSION,
      fallback: { kind: 'deterministic', cause: 'unsettled' },
    })
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'manager' })
    expect(result.observation).toMatchObject({ kind: 'jev', personas: observations })
  })

  it('keeps the timeout fallback decision, its observation and the seeded winner', async () => {
    freezeClock()
    const result = await runJevRoutingReplay(
      tieContext,
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
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policyLatencyMs).toBe(0)
    expect(result.decision).toMatchObject({
      topology: 'persona_requests',
      judgmentSource: 'deterministic',
      policyVersion: DETERMINISTIC_POLICY_VERSION,
      fallback: { kind: 'deterministic', cause: 'timeout' },
    })
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'manager' })
    expect(result.observation).toStrictEqual({ kind: 'timeout' })
  })

  it('keeps the persona-arm decision and observation when every judgment settles', async () => {
    freezeClock()
    const observations = {
      manager: personaObservation(personaJudgments()),
      peer: personaObservation(
        personaJudgments({
          directlyAddressed: 1,
          hasRelevantContribution: 1,
          pauseWouldBenefitUser: 0,
        }),
      ),
      client: personaObservation(personaJudgments()),
    }
    const result = await runJevRoutingReplay(
      context,
      'persona_requests',
      {
        async judgeCentral() {
          throw new Error('unexpected')
        },
        async judgePersona(_context, persona) {
          return { ok: true as const, observation: observations[persona.id as 'manager'] }
        },
      },
      { seed: 1, deadlineMs: 1000 },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policyLatencyMs).toBe(0)
    expect(result.decision).toMatchObject({
      topology: 'persona_requests',
      judgmentSource: 'jev',
      policyVersion: JEV_PERSONA_POLICY_VERSION,
      unsettledPersonas: [],
      fallback: { kind: 'none' },
    })
    expect(result.decision.outcome).toMatchObject({ kind: 'speak', personaId: 'peer' })
    expect(result.observation).toStrictEqual({ kind: 'jev', personas: observations })
  })

  it('clears the deadline timer once the work settles', async () => {
    vi.useFakeTimers()
    try {
      const result = await runJevRoutingReplay(
        context,
        'central_selection',
        {
          async judgeCentral() {
            return { ok: true as const, observation: central(0.9) }
          },
          async judgePersona() {
            throw new Error('unexpected')
          },
        },
        { seed: 1, deadlineMs: 60_000 },
      )
      expect(result.ok).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('routing artifact contract', () => {
  it('stamps the pinned artifact schema version', () => {
    const artifact = routingArtifact(
      context,
      runDeterministicRoutingReplay(context, 'central_selection', 1),
      {
        trialId: '0:en:decision-1',
        taskId: 'decision-1',
        arm: { topology: 'central_selection', judgmentSource: 'deterministic' },
      },
    )
    expect(artifact.schemaVersion).toBe('1.0.0')
  })

  it('rejects a context hash that is not exactly 64 lowercase hex characters', () => {
    const artifact = routingArtifact(
      context,
      runDeterministicRoutingReplay(context, 'central_selection', 1),
      {
        trialId: '0:en:decision-1',
        taskId: 'decision-1',
        arm: { topology: 'central_selection', judgmentSource: 'deterministic' },
      },
    )
    for (const contextHash of [`g${'0'.repeat(64)}`, `${'0'.repeat(64)}g`]) {
      const parsed = routingDecisionArtifactSchema.safeParse({ ...artifact, contextHash })
      expect(parsed.success).toBe(false)
      if (parsed.success) continue
      expect(parsed.error.issues[0]).toMatchObject({
        code: 'invalid_format',
        path: ['contextHash'],
      })
    }
  })
})

describe('writeRoutingArtifacts contract', () => {
  it('writes nothing at all for an empty record list', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'routing-artifacts-'))
    try {
      const path = join(directory, 'routing', 'decisions.jsonl')
      await writeRoutingArtifacts(path, [])
      await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('writes one JSON line per record with a trailing newline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'routing-artifacts-'))
    try {
      const first = routingArtifact(
        context,
        runDeterministicRoutingReplay(context, 'central_selection', 1),
        {
          trialId: '0:en:a',
          taskId: 'a',
          arm: { topology: 'central_selection', judgmentSource: 'deterministic' },
        },
      )
      const second = routingArtifact(
        context,
        runDeterministicRoutingReplay(context, 'central_selection', 1),
        {
          trialId: '0:en:b',
          taskId: 'b',
          arm: { topology: 'central_selection', judgmentSource: 'deterministic' },
        },
      )
      const path = join(directory, 'routing', 'decisions.jsonl')
      await writeRoutingArtifacts(path, [first, second])
      expect(await readFile(path, 'utf8')).toBe(
        `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
