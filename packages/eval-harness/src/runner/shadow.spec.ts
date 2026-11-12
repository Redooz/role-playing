import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRoutingContext } from '@rp/routing-policy'
import { describe, expect, it } from 'vitest'
import { JevUnavailableError } from '../jev/errors.js'
import type {
  JevRoutingJudge,
  RoutingCentralObservation,
  RoutingPersonaObservation,
} from '../jev/routing.js'
import type { JevBatchSuccess } from '../jev/types.js'
import {
  DETERMINISTIC_POLICY_VERSION,
  JEV_CENTRAL_POLICY_VERSION,
  JEV_PERSONA_POLICY_VERSION,
  runDeterministicRoutingReplay,
} from './routing.js'
import {
  runShadowArms,
  summarizeShadowRecords,
  writeShadowRecords,
  writeShadowSummary,
  type ShadowRecord,
} from './shadow.js'

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

function success(
  answers: JevBatchSuccess['answers'],
  questionIds: string[],
  usage: JevBatchSuccess['usage'] = { input_tokens: 10, output_tokens: 2, cost: 0.0001 },
): JevBatchSuccess {
  const response = { model: 'typesafe/jev-1.14-20261014', answers, usage }
  return {
    ok: true,
    questionIds,
    request: { model: 'typesafe/jev-1.14', state: {}, questions: {} },
    response,
    raw: response,
    answers,
    distributions: {},
    usage,
    servedModel: response.model,
    cache: { key: 'a'.repeat(64), hit: false, stored: true },
  }
}

function central(
  value: number,
  selectedPersonaId = 'peer',
  cost: number | null = 0.0002,
): RoutingCentralObservation {
  return {
    judgment: { anyoneWarranted: value, selectedPersonaId },
    exact: success(
      {
        anyone_should_contribute: { type: 'noul', noul: value },
        best_next_speaker: {
          type: 'choice',
          choice: selectedPersonaId,
          probabilities: { manager: 0.1, peer: 0.8, client: 0.1 },
        },
      },
      ['anyone_should_contribute', 'best_next_speaker'],
      cost === null
        ? { input_tokens: 10, output_tokens: 2 }
        : { input_tokens: 10, output_tokens: 2, cost },
    ),
  }
}

function personaObservation(
  personaId: string,
  cost: number | null = 0.0001,
  peerAddressed = true,
): RoutingPersonaObservation {
  const judgments =
    peerAddressed && personaId === 'peer'
      ? {
          directlyAddressed: 1,
          hasRelevantContribution: 1,
          addsUncoveredInformation: 1,
          hasUnmetRelevantObjective: 0,
          pauseWouldBenefitUser: 0,
        }
      : {
          directlyAddressed: 0,
          hasRelevantContribution: 0,
          addsUncoveredInformation: 0,
          hasUnmetRelevantObjective: 0,
          pauseWouldBenefitUser: 1,
        }
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
      cost === null
        ? { input_tokens: 10, output_tokens: 2 }
        : { input_tokens: 10, output_tokens: 2, cost },
    ),
  }
}

interface JudgeOptions {
  readonly centralSelected?: string
  readonly centralWarranted?: number
  readonly centralFailure?: boolean
  readonly personaFailure?: boolean
  readonly omitCost?: boolean
  readonly personaAllPause?: boolean
  readonly delayMs?: number
}

function fakeJudge(options: JudgeOptions = {}): JevRoutingJudge {
  const delay = async () => {
    if (options.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs))
    }
  }
  return {
    async judgeCentral() {
      await delay()
      if (options.centralFailure === true) {
        return {
          ok: false,
          error: new JevUnavailableError('central unavailable', { reason: 'network' }),
          questionIds: ['anyone_should_contribute'],
        }
      }
      const observation = central(
        options.centralWarranted ?? 0.9,
        options.centralSelected ?? 'peer',
        options.omitCost === true ? null : 0.0002,
      )
      return { ok: true, observation }
    },
    async judgePersona(_context, persona) {
      await delay()
      if (options.personaFailure === true) {
        return {
          ok: false,
          error: new JevUnavailableError('persona unavailable', { reason: 'network' }),
          questionIds: ['directly_addressed'],
        }
      }
      return {
        ok: true,
        observation: personaObservation(
          persona.id,
          options.omitCost === true ? null : 0.0001,
          options.personaAllPause !== true,
        ),
      }
    },
  }
}

const liveDecision = runDeterministicRoutingReplay(context, 'persona_requests', 1).decision

describe('runShadowArms', () => {
  it('records the three non-live arms and their agreement with the live decision', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      fakeJudge({ centralSelected: 'client' }),
    )

    expect(result.records.map((record) => record.arm)).toEqual([
      'jev-persona',
      'det-central',
      'jev-central',
    ])

    const byArm = new Map(result.records.map((record) => [record.arm, record]))
    expect(byArm.get('det-central')).toMatchObject({
      policyVersion: DETERMINISTIC_POLICY_VERSION,
      outcome: { kind: 'speak', personaId: 'peer' },
      agreement: true,
      fallbackCause: null,
      unsettled: false,
    })
    expect(byArm.get('jev-persona')).toMatchObject({
      policyVersion: JEV_PERSONA_POLICY_VERSION,
      outcome: { kind: 'speak', personaId: 'peer' },
      agreement: true,
      usage: { inputTokens: 30, outputTokens: 6 },
    })
    expect(byArm.get('jev-persona')?.usage?.costUsd).toBeCloseTo(0.0003, 12)
    expect(byArm.get('jev-central')).toMatchObject({
      policyVersion: JEV_CENTRAL_POLICY_VERSION,
      outcome: { kind: 'speak', personaId: 'client' },
      agreement: false,
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.0002 },
    })
  })

  it('does not mutate the live decision or the routing context', async () => {
    const liveBefore = structuredClone(liveDecision)
    const contextBefore = structuredClone(context)
    await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      fakeJudge({ centralSelected: 'client' }),
    )
    expect(liveDecision).toEqual(liveBefore)
    expect(context).toEqual(contextBefore)
  })

  it('keeps a Jev transport failure as an incomplete record', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      fakeJudge({ personaFailure: true }),
    )
    const persona = result.records.find((record) => record.arm === 'jev-persona')
    expect(persona).toMatchObject({
      policyVersion: JEV_PERSONA_POLICY_VERSION,
      decision: null,
      outcome: { kind: 'infrastructure_incomplete' },
      agreement: null,
      usage: null,
      fallbackCause: null,
      unsettled: false,
    })
    expect(persona?.error).toContain('persona unavailable')

    const summary = result.summary.arms.find((arm) => arm.arm === 'jev-persona')
    expect(summary).toMatchObject({ completed: 0, incomplete: 1, agreementRate: null })
  })

  it('records a Jev timeout as a deterministic fallback, not as an incomplete', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1, deadlineMs: 5 },
      fakeJudge({ centralSelected: 'client', delayMs: 25 }),
    )
    const central = result.records.find((record) => record.arm === 'jev-central')
    expect(central).toMatchObject({
      decision: expect.anything(),
      outcome: { kind: 'speak', personaId: 'peer' },
      fallbackCause: 'timeout',
      agreement: true,
      usage: null,
      observation: { kind: 'timeout' },
    })
    expect(central?.error).toContain('timed out')
  })

  it('keeps an unknown cost null instead of zero', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      fakeJudge({ omitCost: true }),
    )
    for (const record of result.records) {
      if (record.usage !== null) {
        expect(record.usage.costUsd).toBeNull()
        expect(record.usage.inputTokens).toBeGreaterThan(0)
      }
    }
  })

  it('rejects an empty task id and an invalid deadline before calling the judge', async () => {
    let calls = 0
    const judge: JevRoutingJudge = {
      async judgeCentral() {
        calls += 1
        throw new Error('must not be called')
      },
      async judgePersona() {
        calls += 1
        throw new Error('must not be called')
      },
    }

    await expect(
      runShadowArms({ taskId: '  ', context, liveDecision, seed: 1 }, judge),
    ).rejects.toThrow(/task id/u)
    await expect(
      runShadowArms({ taskId: 'task-1', context, liveDecision, seed: 1, deadlineMs: 0 }, judge),
    ).rejects.toThrow(/positive finite/u)
    expect(calls).toBe(0)
  })
})

describe('shadow summary', () => {
  it('reports each arm separately with no composite score', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      fakeJudge({ centralSelected: 'client' }),
    )
    expect(result.summary).toMatchObject({
      kind: 'routing.shadow.summary',
      taskId: 'task-1',
      lang: 'en',
      records: 3,
    })
    expect(result.summary.arms.map((arm) => arm.arm)).toEqual([
      'jev-persona',
      'det-central',
      'jev-central',
    ])
    for (const arm of result.summary.arms) {
      expect(arm.records).toBe(1)
      expect(arm.agreementRate).toBe(arm.agreements / (arm.agreements + arm.disagreements))
      const latency = arm.latencyMs
      if (latency === null) throw new Error('a completed arm needs a latency summary')
      expect(latency.p50).toBeGreaterThanOrEqual(0)
      expect(latency.p95).toBeGreaterThanOrEqual(latency.p50)
    }
  })

  it('keeps yields comparable with the live yield', async () => {
    const allDecline = parseRoutingContext({
      ...context,
      transcript: [{ speaker: { kind: 'user' }, text: 'Thanks, noted.' }],
    })
    const live = runDeterministicRoutingReplay(allDecline, 'persona_requests', 1).decision
    const result = await runShadowArms(
      { taskId: 'task-2', context: allDecline, liveDecision: live, seed: 1 },
      fakeJudge({ centralWarranted: 0.1, personaAllPause: true }),
    )
    expect(live.outcome).toEqual({ kind: 'user_yield', reason: 'all_declined' })
    expect(result.records.every((record) => record.outcome.kind === 'user_yield')).toBe(true)
    expect(result.records.every((record) => record.agreement === true)).toBe(true)
  })

  it('summarizes a filtered record set without inventing missing arms', () => {
    const record: ShadowRecord = {
      schemaVersion: '1.0.0',
      kind: 'routing.shadow',
      contentClass: 'restricted',
      taskId: 'task-1',
      lang: 'en',
      arm: 'det-central',
      policyVersion: DETERMINISTIC_POLICY_VERSION,
      decision: liveDecision,
      outcome: { kind: 'speak', personaId: 'peer' },
      fallbackCause: null,
      unsettled: false,
      latencyMs: 1,
      usage: null,
      agreement: true,
      observation: { kind: 'deterministic' },
    }
    const summary = summarizeShadowRecords('task-1', 'en', [record])
    expect(summary.arms).toHaveLength(3)
    expect(summary.arms.find((arm) => arm.arm === 'det-central')?.records).toBe(1)
    expect(summary.arms.find((arm) => arm.arm === 'jev-central')?.records).toBe(0)
    expect(summary.arms.find((arm) => arm.arm === 'jev-central')?.agreementRate).toBeNull()

    expect(() => summarizeShadowRecords('task-2', 'en', [record])).toThrow(/belongs to task-1/u)
    expect(() => summarizeShadowRecords('task-1', 'fr', [record])).toThrow(/belongs to task-1/u)
  })
})

describe('shadow artifacts', () => {
  it('appends restricted JSONL records and writes a JSON summary', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      fakeJudge({ centralSelected: 'client' }),
    )
    const directory = await mkdtemp(join(tmpdir(), 'rp-shadow-'))
    try {
      const recordsPath = join(directory, 'shadow.jsonl')
      const summaryPath = join(directory, 'shadow-summary.json')
      await writeShadowRecords(recordsPath, result.records)
      await writeShadowRecords(recordsPath, result.records)
      await writeShadowSummary(summaryPath, result.summary)

      const lines = (await readFile(recordsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as ShadowRecord)
      expect(lines).toHaveLength(6)
      expect(lines.every((record) => record.contentClass === 'restricted')).toBe(true)
      expect(JSON.parse(await readFile(summaryPath, 'utf8'))).toEqual(result.summary)

      await expect(
        writeShadowSummary(summaryPath, { ...result.summary, records: 9 }),
      ).rejects.toThrow(/do not match arm total/u)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('writes nothing for an empty record list', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rp-shadow-'))
    try {
      const path = join(directory, 'shadow.jsonl')
      await writeShadowRecords(path, [])
      await expect(readFile(path, 'utf8')).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
