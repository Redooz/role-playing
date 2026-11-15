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
  SHADOW_ARM_IDS,
  SHADOW_DEADLINE_MS,
  SHADOW_SCHEMA_VERSION,
  runShadowArms,
  shadowArmSummarySchema,
  shadowOutcomeSchema,
  shadowRecordSchema,
  shadowSummarySchema,
  shadowUsageSchema,
  summarizeShadowRecords,
  writeShadowRecords,
  writeShadowSummary,
  type ShadowArmId,
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
  usage?: JevBatchSuccess['usage'],
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
      usage ??
        (cost === null
          ? { input_tokens: 10, output_tokens: 2 }
          : { input_tokens: 10, output_tokens: 2, cost }),
    ),
  }
}

function personaObservation(
  personaId: string,
  cost: number | null = 0.0001,
  peerAddressed = true,
  usage?: JevBatchSuccess['usage'],
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
      usage ??
        (cost === null
          ? { input_tokens: 10, output_tokens: 2 }
          : { input_tokens: 10, output_tokens: 2, cost }),
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

interface UsageJudgeOptions {
  readonly personaUsage?: (personaId: string) => JevBatchSuccess['usage']
  readonly centralUsage?: JevBatchSuccess['usage']
}

/** A judge whose per-call usage can be varied without changing its decisions. */
function usageJudge(options: UsageJudgeOptions = {}): JevRoutingJudge {
  return {
    async judgeCentral() {
      return { ok: true, observation: central(0.9, 'peer', 0.0002, options.centralUsage) }
    },
    async judgePersona(_context, persona) {
      return {
        ok: true,
        observation: personaObservation(
          persona.id,
          0.0001,
          true,
          options.personaUsage?.(persona.id),
        ),
      }
    },
  }
}

/** A judge whose transport fails with the given message. */
function throwingJudge(message: string): JevRoutingJudge {
  return {
    async judgeCentral() {
      throw new Error(message)
    },
    async judgePersona() {
      throw new Error(message)
    },
  }
}

function usagesByPersona(
  overrides: Readonly<Record<string, JevBatchSuccess['usage']>> = {},
  fallback: JevBatchSuccess['usage'] = { input_tokens: 10, output_tokens: 2, cost: 0.0001 },
): (personaId: string) => JevBatchSuccess['usage'] {
  return (personaId) => overrides[personaId] ?? fallback
}

/** A valid restricted shadow record; tests override only the field under test. */
function shadowRecord(overrides: Partial<ShadowRecord> = {}): ShadowRecord {
  return {
    schemaVersion: SHADOW_SCHEMA_VERSION,
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
    ...overrides,
  }
}

function zeroArm(arm: ShadowArmId) {
  return {
    arm,
    records: 0,
    completed: 0,
    incomplete: 0,
    speak: 0,
    yield: 0,
    agreements: 0,
    disagreements: 0,
    agreementRate: null,
    timeoutFallbacks: 0,
    unsettledFallbacks: 0,
    latencyMs: null,
    usage: null,
  }
}

function armSummary(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    arm: 'det-central',
    records: 2,
    completed: 2,
    incomplete: 0,
    speak: 1,
    yield: 1,
    agreements: 2,
    disagreements: 0,
    agreementRate: 1,
    timeoutFallbacks: 0,
    unsettledFallbacks: 0,
    latencyMs: { p50: 1, p95: 2 },
    usage: null,
    ...overrides,
  }
}

function validSummary(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schemaVersion: SHADOW_SCHEMA_VERSION,
    kind: 'routing.shadow.summary',
    contentClass: 'restricted',
    taskId: 'task-1',
    lang: 'en',
    records: 0,
    arms: SHADOW_ARM_IDS.map((arm) => zeroArm(arm)),
    ...overrides,
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
      policyVersion: JEV_CENTRAL_POLICY_VERSION,
      decision: expect.anything(),
      outcome: { kind: 'speak', personaId: 'peer' },
      fallbackCause: 'timeout',
      agreement: null,
      usage: null,
      observation: { kind: 'timeout' },
    })
    expect(central?.error).toContain('timed out')

    const summary = result.summary.arms.find((arm) => arm.arm === 'jev-central')
    expect(summary).toMatchObject({
      completed: 1,
      incomplete: 0,
      timeoutFallbacks: 1,
      agreementRate: null,
    })
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

    const byArm = new Map(result.records.map((record) => [record.arm, record]))
    expect(byArm.get('jev-persona')?.outcome).toStrictEqual({
      kind: 'user_yield',
      reason: 'all_declined',
    })
    expect(byArm.get('det-central')?.outcome).toStrictEqual({
      kind: 'user_yield',
      reason: 'all_declined',
    })
    expect(byArm.get('jev-central')?.outcome).toStrictEqual({
      kind: 'user_yield',
      reason: 'all_declined',
    })
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

  it('keeps a timeout out of the agreement denominator', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1, deadlineMs: 5 },
      fakeJudge({ centralSelected: 'client', delayMs: 25 }),
    )
    const arm = result.summary.arms.find((entry) => entry.arm === 'jev-central')!
    expect(arm.timeoutFallbacks).toBe(1)
    expect(arm.agreements + arm.disagreements).toBe(arm.completed - arm.timeoutFallbacks)
    expect(() => shadowArmSummarySchema.parse({ ...arm, agreements: arm.agreements + 1 })).toThrow(
      /agreement denominator/u,
    )
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

describe('shadow contract', () => {
  it('pins the schema version, shadow deadline and arm order', () => {
    expect(SHADOW_SCHEMA_VERSION).toBe('1.0.0')
    expect(SHADOW_DEADLINE_MS).toBe(2_500)
    expect(SHADOW_ARM_IDS).toStrictEqual(['jev-persona', 'det-central', 'jev-central'])
  })

  it('accepts the three outcome branches and rejects unknown shapes', () => {
    expect(shadowOutcomeSchema.parse({ kind: 'speak', personaId: 'peer' })).toStrictEqual({
      kind: 'speak',
      personaId: 'peer',
    })
    expect(
      shadowOutcomeSchema.parse({ kind: 'user_yield', reason: 'policy_timeout' }),
    ).toStrictEqual({ kind: 'user_yield', reason: 'policy_timeout' })
    expect(shadowOutcomeSchema.parse({ kind: 'infrastructure_incomplete' })).toStrictEqual({
      kind: 'infrastructure_incomplete',
    })

    expect(() => shadowOutcomeSchema.parse({ kind: 'speak', personaId: '' })).toThrow()
    expect(() => shadowOutcomeSchema.parse({ kind: 'speak' })).toThrow()
    expect(() => shadowOutcomeSchema.parse({ kind: 'user_yield', reason: 'unknown' })).toThrow()
    expect(() => shadowOutcomeSchema.parse({ kind: 'unknown' })).toThrow()
    expect(() =>
      shadowOutcomeSchema.parse({ kind: 'infrastructure_incomplete', extra: true }),
    ).toThrow()
  })

  it('allows null and zero usage but rejects fractional, negative and non-finite values', () => {
    const usage = { inputTokens: 0, outputTokens: null, costUsd: 0 }
    expect(shadowUsageSchema.parse(usage)).toStrictEqual(usage)
    expect(
      shadowUsageSchema.parse({ inputTokens: null, outputTokens: 2, costUsd: null }),
    ).toStrictEqual({ inputTokens: null, outputTokens: 2, costUsd: null })

    expect(() =>
      shadowUsageSchema.parse({ inputTokens: 1.5, outputTokens: null, costUsd: null }),
    ).toThrow()
    expect(() =>
      shadowUsageSchema.parse({ inputTokens: -1, outputTokens: null, costUsd: null }),
    ).toThrow()
    expect(() =>
      shadowUsageSchema.parse({ inputTokens: null, outputTokens: null, costUsd: -0.01 }),
    ).toThrow()
    expect(() =>
      shadowUsageSchema.parse({ inputTokens: null, outputTokens: null, costUsd: Infinity }),
    ).toThrow()
    expect(() => shadowUsageSchema.parse({ inputTokens: 1, outputTokens: 1 })).toThrow()
    expect(() => shadowUsageSchema.parse({ ...usage, extra: 1 })).toThrow()
  })

  it('accepts a complete record and rejects unknown keys and invalid enums', () => {
    const record = shadowRecord()
    expect(shadowRecordSchema.parse(record)).toStrictEqual(record)
    expect(shadowRecordSchema.parse({ ...record, error: 'policy failed' })).toStrictEqual({
      ...record,
      error: 'policy failed',
    })
    expect(shadowRecordSchema.parse({ ...record, decision: null }).decision).toBeNull()
    expect(shadowRecordSchema.parse({ ...record, lang: 'fr' }).lang).toBe('fr')
    expect(shadowRecordSchema.parse({ ...record, fallbackCause: 'unsettled' }).fallbackCause).toBe(
      'unsettled',
    )

    expect(() => shadowRecordSchema.parse({ ...record, extra: 1 })).toThrow()
    expect(() => shadowRecordSchema.parse({ ...record, lang: '' })).toThrow()
    expect(() => shadowRecordSchema.parse({ ...record, lang: 'de' })).toThrow()
    expect(() => shadowRecordSchema.parse({ ...record, fallbackCause: '' })).toThrow()
    expect(() => shadowRecordSchema.parse({ ...record, fallbackCause: 'error' })).toThrow()
    expect(() => shadowRecordSchema.parse({ ...record, taskId: '' })).toThrow()
    expect(() => shadowRecordSchema.parse({ ...record, policyVersion: '' })).toThrow()
    expect(() => shadowRecordSchema.parse({ ...record, arm: 'det-persona' })).toThrow()
    expect(() => shadowRecordSchema.parse({ ...record, error: '' })).toThrow()
    expect(() => shadowRecordSchema.parse({ ...record, latencyMs: -1 })).toThrow()
    expect(() => shadowRecordSchema.parse({ ...record, schemaVersion: '2.0.0' })).toThrow()
    expect(() => shadowRecordSchema.parse({ ...record, kind: 'routing.decision' })).toThrow()
    expect(() => shadowRecordSchema.parse({ ...record, contentClass: 'public' })).toThrow()
    expect(() =>
      shadowRecordSchema.parse({ ...record, outcome: { kind: 'speak', personaId: '' } }),
    ).toThrow()
  })

  it('keeps the agreement denominator to completed non-timeout records', () => {
    expect(shadowArmSummarySchema.parse(armSummary())).toStrictEqual(armSummary())

    const withTimeout = armSummary({
      records: 2,
      completed: 2,
      agreements: 1,
      disagreements: 0,
      agreementRate: 1,
      timeoutFallbacks: 1,
    })
    expect(shadowArmSummarySchema.parse(withTimeout)).toStrictEqual(withTimeout)

    const parsed = shadowArmSummarySchema.safeParse(
      armSummary({ agreements: 1, agreementRate: 0.5 }),
    )
    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error('expected the agreement denominator to fail')
    expect(parsed.error.issues).toStrictEqual([
      {
        code: 'custom',
        path: ['agreementRate'],
        message: 'only completed non-timeout records may enter the agreement denominator',
      },
    ])

    expect(() => shadowArmSummarySchema.parse(armSummary({ agreementRate: 1.5 }))).toThrow()
    expect(() => shadowArmSummarySchema.parse(armSummary({ completed: -1 }))).toThrow()
    expect(() => shadowArmSummarySchema.parse(armSummary({ records: 1.5 }))).toThrow()
    expect(() => shadowArmSummarySchema.parse(armSummary({ extra: 1 }))).toThrow()
  })

  it('matches the summary record count to the arm total', () => {
    expect(shadowSummarySchema.parse(validSummary())).toStrictEqual(validSummary())
    expect(shadowSummarySchema.parse({ ...validSummary(), lang: 'fr' }).lang).toBe('fr')
    expect(() => shadowSummarySchema.parse({ ...validSummary(), lang: '' })).toThrow()
    expect(() => shadowSummarySchema.parse({ ...validSummary(), lang: 'de' })).toThrow()
    expect(() => shadowSummarySchema.parse({ ...validSummary(), extra: 1 })).toThrow()

    const parsed = shadowSummarySchema.safeParse(validSummary({ records: 1 }))
    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error('expected the arm total refinement to fail')
    expect(parsed.error.issues).toStrictEqual([
      {
        code: 'custom',
        path: ['records'],
        message: 'summary records 1 do not match arm total 0',
      },
    ])
  })
})

describe('summarizeShadowRecords counts', () => {
  it('counts speaks, yields, agreements and incompletes without a composite score', () => {
    const records: ShadowRecord[] = [
      shadowRecord({ arm: 'jev-persona', latencyMs: 10 }),
      shadowRecord({
        arm: 'jev-persona',
        outcome: { kind: 'user_yield', reason: 'all_declined' },
        latencyMs: 20,
      }),
      shadowRecord({
        arm: 'jev-persona',
        outcome: { kind: 'user_yield', reason: 'all_declined' },
        agreement: false,
        latencyMs: 30,
      }),
      shadowRecord({
        arm: 'jev-persona',
        outcome: { kind: 'infrastructure_incomplete' },
        agreement: null,
        latencyMs: 40,
      }),
    ]

    expect(summarizeShadowRecords('task-1', 'en', records)).toStrictEqual({
      schemaVersion: SHADOW_SCHEMA_VERSION,
      kind: 'routing.shadow.summary',
      contentClass: 'restricted',
      taskId: 'task-1',
      lang: 'en',
      records: 4,
      arms: [
        {
          arm: 'jev-persona',
          records: 4,
          completed: 3,
          incomplete: 1,
          speak: 1,
          yield: 2,
          agreements: 2,
          disagreements: 1,
          agreementRate: 2 / 3,
          timeoutFallbacks: 0,
          unsettledFallbacks: 0,
          latencyMs: { p50: 20, p95: expect.closeTo(29) },
          usage: null,
        },
        zeroArm('det-central'),
        zeroArm('jev-central'),
      ],
    })
  })

  it('counts timeout and unsettled fallbacks while excluding timeouts from agreement', () => {
    const records: ShadowRecord[] = [
      shadowRecord({
        arm: 'det-central',
        outcome: { kind: 'user_yield', reason: 'unsettled' },
        fallbackCause: 'unsettled',
        latencyMs: 5,
      }),
      shadowRecord({
        arm: 'det-central',
        outcome: { kind: 'user_yield', reason: 'policy_timeout' },
        fallbackCause: 'timeout',
        agreement: null,
        latencyMs: 5,
      }),
      shadowRecord({ arm: 'det-central', agreement: false, latencyMs: 5 }),
      shadowRecord({
        arm: 'det-central',
        outcome: { kind: 'infrastructure_incomplete' },
        agreement: null,
        latencyMs: 9,
      }),
    ]

    expect(summarizeShadowRecords('task-1', 'en', records).arms[1]).toStrictEqual({
      arm: 'det-central',
      records: 4,
      completed: 3,
      incomplete: 1,
      speak: 1,
      yield: 2,
      agreements: 1,
      disagreements: 1,
      agreementRate: 0.5,
      timeoutFallbacks: 1,
      unsettledFallbacks: 1,
      latencyMs: { p50: 5, p95: 5 },
      usage: null,
    })
  })

  it('summarizes an empty record set with three empty arms', () => {
    expect(summarizeShadowRecords('task-1', 'en', [])).toStrictEqual({
      schemaVersion: SHADOW_SCHEMA_VERSION,
      kind: 'routing.shadow.summary',
      contentClass: 'restricted',
      taskId: 'task-1',
      lang: 'en',
      records: 0,
      arms: [zeroArm('jev-persona'), zeroArm('det-central'), zeroArm('jev-central')],
    })
  })

  it('rejects a record from another task or language with the exact message', () => {
    const record = shadowRecord()
    expect(() => summarizeShadowRecords('task-2', 'en', [record])).toThrow(
      'shadow record det-central belongs to task-1/en, not task-2/en',
    )
    expect(() => summarizeShadowRecords('task-1', 'fr', [record])).toThrow(
      'shadow record det-central belongs to task-1/en, not task-1/fr',
    )
    expect(() =>
      summarizeShadowRecords('task-1', 'en', [{ ...record, lang: '' } as unknown as ShadowRecord]),
    ).toThrow()
  })
})

describe('summarizeShadowRecords percentiles', () => {
  it('interpolates an even count and a single latency', () => {
    const even = [10, 20, 30, 40].map((latencyMs) => shadowRecord({ latencyMs }))
    const evenArm = summarizeShadowRecords('task-1', 'en', even).arms[1]!
    expect(evenArm.latencyMs).toStrictEqual({ p50: 25, p95: expect.closeTo(38.5) })

    const single = summarizeShadowRecords('task-1', 'en', [shadowRecord({ latencyMs: 7 })]).arms[1]!
    expect(single.latencyMs).toStrictEqual({ p50: 7, p95: 7 })
  })

  it('sorts latency before interpolating', () => {
    const unsorted = [30, 10, 20].map((latencyMs) => shadowRecord({ latencyMs }))
    expect(summarizeShadowRecords('task-1', 'en', unsorted).arms[1]!.latencyMs).toStrictEqual({
      p50: 20,
      p95: expect.closeTo(29),
    })
  })
})

describe('summarizeShadowRecords usage', () => {
  it('sums known usage across records', () => {
    const records = [
      shadowRecord({ usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.5 } }),
      shadowRecord({ usage: { inputTokens: 20, outputTokens: 3, costUsd: 0.25 } }),
    ]
    expect(summarizeShadowRecords('task-1', 'en', records).arms[1]!.usage).toStrictEqual({
      inputTokens: 30,
      outputTokens: 5,
      costUsd: 0.75,
    })
  })

  it('keeps a usage key null when any record has it null', () => {
    const records = [
      shadowRecord({ usage: { inputTokens: null, outputTokens: 2, costUsd: 0.5 } }),
      shadowRecord({ usage: { inputTokens: 10, outputTokens: null, costUsd: null } }),
    ]
    expect(summarizeShadowRecords('task-1', 'en', records).arms[1]!.usage).toStrictEqual({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    })
  })

  it('has no usage when every record has none', () => {
    const records = [shadowRecord({ usage: null }), shadowRecord({ usage: null })]
    expect(summarizeShadowRecords('task-1', 'en', records).arms[1]!.usage).toBeNull()
  })
})

describe('runShadowArms record shape', () => {
  it('writes every field of a completed record', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      fakeJudge({ centralSelected: 'client' }),
    )
    const [persona, deterministic, centralArm] = result.records

    expect(persona).toStrictEqual({
      schemaVersion: SHADOW_SCHEMA_VERSION,
      kind: 'routing.shadow',
      contentClass: 'restricted',
      taskId: 'task-1',
      lang: 'en',
      arm: 'jev-persona',
      policyVersion: JEV_PERSONA_POLICY_VERSION,
      decision: expect.objectContaining({
        policyVersion: JEV_PERSONA_POLICY_VERSION,
        topology: 'persona_requests',
        fallback: { kind: 'none' },
      }),
      outcome: { kind: 'speak', personaId: 'peer' },
      fallbackCause: null,
      unsettled: false,
      latencyMs: expect.any(Number),
      usage: { inputTokens: 30, outputTokens: 6, costUsd: expect.any(Number) },
      agreement: true,
      observation: expect.objectContaining({ kind: 'jev' }),
    })
    expect(persona?.usage?.costUsd).toBeCloseTo(0.0003, 12)

    expect(deterministic).toStrictEqual({
      schemaVersion: SHADOW_SCHEMA_VERSION,
      kind: 'routing.shadow',
      contentClass: 'restricted',
      taskId: 'task-1',
      lang: 'en',
      arm: 'det-central',
      policyVersion: DETERMINISTIC_POLICY_VERSION,
      decision: expect.objectContaining({
        policyVersion: DETERMINISTIC_POLICY_VERSION,
        topology: 'central_selection',
        fallback: { kind: 'none' },
      }),
      outcome: { kind: 'speak', personaId: 'peer' },
      fallbackCause: null,
      unsettled: false,
      latencyMs: expect.any(Number),
      usage: null,
      agreement: true,
      observation: { kind: 'deterministic' },
    })

    expect(centralArm).toStrictEqual({
      schemaVersion: SHADOW_SCHEMA_VERSION,
      kind: 'routing.shadow',
      contentClass: 'restricted',
      taskId: 'task-1',
      lang: 'en',
      arm: 'jev-central',
      policyVersion: JEV_CENTRAL_POLICY_VERSION,
      decision: expect.objectContaining({
        policyVersion: JEV_CENTRAL_POLICY_VERSION,
        topology: 'central_selection',
        fallback: { kind: 'none' },
      }),
      outcome: { kind: 'speak', personaId: 'client' },
      fallbackCause: null,
      unsettled: false,
      latencyMs: expect.any(Number),
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.0002 },
      agreement: false,
      observation: expect.objectContaining({ kind: 'jev' }),
    })
  })

  it('writes every field of a timeout record', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1, deadlineMs: 5 },
      fakeJudge({ centralSelected: 'client', delayMs: 25 }),
    )
    const centralArm = result.records.find((record) => record.arm === 'jev-central')

    expect(centralArm).toStrictEqual({
      schemaVersion: SHADOW_SCHEMA_VERSION,
      kind: 'routing.shadow',
      contentClass: 'restricted',
      taskId: 'task-1',
      lang: 'en',
      arm: 'jev-central',
      policyVersion: JEV_CENTRAL_POLICY_VERSION,
      decision: expect.objectContaining({
        fallback: { kind: 'deterministic', cause: 'timeout' },
      }),
      outcome: { kind: 'speak', personaId: 'peer' },
      fallbackCause: 'timeout',
      unsettled: false,
      latencyMs: expect.any(Number),
      usage: null,
      agreement: null,
      observation: { kind: 'timeout' },
      error: 'shadow policy timed out; deterministic fallback recorded for audit only',
    })
  })

  it('marks an unsettled fallback and compares it with the live yield', async () => {
    const allDecline = parseRoutingContext({
      ...context,
      transcript: [{ speaker: { kind: 'user' }, text: 'Thanks, noted.' }],
    })
    const live = runDeterministicRoutingReplay(allDecline, 'persona_requests', 1).decision
    const result = await runShadowArms(
      { taskId: 'task-2', context: allDecline, liveDecision: live, seed: 1 },
      fakeJudge({ centralWarranted: 0.5, personaAllPause: true }),
    )
    const centralArm = result.records.find((record) => record.arm === 'jev-central')

    expect(centralArm).toStrictEqual({
      schemaVersion: SHADOW_SCHEMA_VERSION,
      kind: 'routing.shadow',
      contentClass: 'restricted',
      taskId: 'task-2',
      lang: 'en',
      arm: 'jev-central',
      policyVersion: JEV_CENTRAL_POLICY_VERSION,
      decision: expect.objectContaining({
        fallback: { kind: 'deterministic', cause: 'unsettled' },
        outcome: { kind: 'user_yield', reason: 'unsettled' },
      }),
      outcome: { kind: 'user_yield', reason: 'unsettled' },
      fallbackCause: 'unsettled',
      unsettled: true,
      latencyMs: expect.any(Number),
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.0002 },
      agreement: false,
      observation: expect.objectContaining({ kind: 'jev' }),
    })

    const summaryArm = result.summary.arms.find((arm) => arm.arm === 'jev-central')!
    expect(summaryArm).toStrictEqual({
      arm: 'jev-central',
      records: 1,
      completed: 1,
      incomplete: 0,
      speak: 0,
      yield: 1,
      agreements: 0,
      disagreements: 1,
      agreementRate: 0,
      timeoutFallbacks: 0,
      unsettledFallbacks: 1,
      latencyMs: { p50: expect.any(Number), p95: expect.any(Number) },
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.0002 },
    })
  })

  it('treats a different outcome kind as disagreement', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      fakeJudge({ centralWarranted: 0.1 }),
    )
    const centralArm = result.records.find((record) => record.arm === 'jev-central')!

    expect(centralArm.outcome).toStrictEqual({ kind: 'user_yield', reason: 'all_declined' })
    expect(centralArm.agreement).toBe(false)
    expect(centralArm.fallbackCause).toBeNull()
    expect(centralArm.unsettled).toBe(false)
  })

  it('writes every field of an incomplete record', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      throwingJudge('   '),
    )

    expect(result.records[0]).toStrictEqual({
      schemaVersion: SHADOW_SCHEMA_VERSION,
      kind: 'routing.shadow',
      contentClass: 'restricted',
      taskId: 'task-1',
      lang: 'en',
      arm: 'jev-persona',
      policyVersion: JEV_PERSONA_POLICY_VERSION,
      decision: null,
      outcome: { kind: 'infrastructure_incomplete' },
      fallbackCause: null,
      unsettled: false,
      latencyMs: expect.any(Number),
      usage: null,
      agreement: null,
      observation: { kind: 'none' },
      error: 'shadow policy failed without a message',
    })
    expect(result.records[2]?.arm).toBe('jev-central')
    expect(result.records[2]?.error).toBe('shadow policy failed without a message')
  })

  it('names the failure when the policy reports an empty message', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      throwingJudge(''),
    )
    expect(result.records[0]?.error).toBe('shadow policy failed without a message')
    expect(result.records[2]?.error).toBe('shadow policy failed without a message')
  })

  it('keeps a non-empty policy failure message verbatim', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      throwingJudge('transport blew up'),
    )
    expect(result.records[0]?.error).toBe('transport blew up')
    expect(result.records[2]?.error).toBe('transport blew up')
  })

  it('rejects every invalid deadline with the exact message', async () => {
    const judge = throwingJudge('the judge must not run')
    for (const deadlineMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        runShadowArms({ taskId: 'task-1', context, liveDecision, seed: 1, deadlineMs }, judge),
      ).rejects.toThrow('shadow deadlineMs must be a positive finite number')
    }
    await expect(
      runShadowArms({ taskId: '', context, liveDecision, seed: 1 }, judge),
    ).rejects.toThrow('a shadow run needs a task id')
    await expect(
      runShadowArms({ taskId: '   ', context, liveDecision, seed: 1 }, judge),
    ).rejects.toThrow('a shadow run needs a task id')
  })
})

describe('runShadowArms usage', () => {
  it('sums the persona batches', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      usageJudge(),
    )
    const persona = result.records[0]!
    expect(persona.usage).toStrictEqual({
      inputTokens: 30,
      outputTokens: 6,
      costUsd: expect.any(Number),
    })
    expect(persona.usage?.costUsd).toBeCloseTo(0.0003, 12)
  })

  it('keeps the input sum null when any batch reports a negative count', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      usageJudge({
        personaUsage: usagesByPersona({
          manager: { input_tokens: -1, output_tokens: 2, cost: 0.0001 },
        }),
      }),
    )
    const persona = result.records[0]!
    expect(persona.usage).toStrictEqual({
      inputTokens: null,
      outputTokens: 6,
      costUsd: expect.any(Number),
    })
    expect(persona.usage?.costUsd).toBeCloseTo(0.0003, 12)
  })

  it('counts a zero token count as known', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      usageJudge({
        personaUsage: usagesByPersona({}, { input_tokens: 0, output_tokens: 2, cost: 0.0001 }),
      }),
    )
    expect(result.records[0]?.usage).toStrictEqual({
      inputTokens: 0,
      outputTokens: 6,
      costUsd: expect.any(Number),
    })
  })

  it('keeps the output sum null when any batch reports a negative count', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      usageJudge({
        personaUsage: usagesByPersona({
          manager: { input_tokens: 10, output_tokens: -1, cost: 0.0001 },
        }),
      }),
    )
    expect(result.records[0]?.usage).toStrictEqual({
      inputTokens: 30,
      outputTokens: null,
      costUsd: expect.any(Number),
    })
  })

  it('counts a zero output count as known', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      usageJudge({
        personaUsage: usagesByPersona({}, { input_tokens: 10, output_tokens: 0, cost: 0.0001 }),
      }),
    )
    expect(result.records[0]?.usage).toStrictEqual({
      inputTokens: 30,
      outputTokens: 0,
      costUsd: expect.any(Number),
    })
  })

  it('keeps the cost null when a batch reports a non-finite cost', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      usageJudge({
        personaUsage: usagesByPersona({
          manager: { input_tokens: 10, output_tokens: 2, cost: Number.NaN },
        }),
      }),
    )
    expect(result.records[0]?.usage).toStrictEqual({
      inputTokens: 30,
      outputTokens: 6,
      costUsd: null,
    })
  })

  it('keeps the cost null when only some batches report one', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      usageJudge({
        personaUsage: usagesByPersona({
          manager: { input_tokens: 10, output_tokens: 2 },
        }),
      }),
    )
    expect(result.records[0]?.usage).toStrictEqual({
      inputTokens: 30,
      outputTokens: 6,
      costUsd: null,
    })
  })

  it('sums a central batch', async () => {
    const result = await runShadowArms(
      { taskId: 'task-1', context, liveDecision, seed: 1 },
      usageJudge({ centralUsage: { input_tokens: 4, output_tokens: 1, cost: 0.2 } }),
    )
    expect(result.records[2]?.usage).toStrictEqual({
      inputTokens: 4,
      outputTokens: 1,
      costUsd: 0.2,
    })
  })
})

describe('shadow artifact bytes', () => {
  it('creates nested directories and writes exact JSONL and pretty JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rp-shadow-'))
    try {
      const recordsPath = join(directory, 'nested', 'deeper', 'shadow.jsonl')
      const summaryPath = join(directory, 'nested', 'deeper', 'shadow-summary.json')
      const records = [shadowRecord(), shadowRecord({ arm: 'jev-persona', latencyMs: 2 })]
      await writeShadowRecords(recordsPath, records)
      expect(await readFile(recordsPath, 'utf8')).toBe(
        `${records.map((record) => JSON.stringify(shadowRecordSchema.parse(record))).join('\n')}\n`,
      )

      const summary = summarizeShadowRecords('task-1', 'en', records)
      await writeShadowSummary(summaryPath, summary)
      expect(await readFile(summaryPath, 'utf8')).toBe(
        `${JSON.stringify(shadowSummarySchema.parse(summary), null, 2)}\n`,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects an invalid record and writes nothing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rp-shadow-'))
    try {
      const path = join(directory, 'shadow.jsonl')
      const invalid = { ...shadowRecord(), lang: '' } as unknown as ShadowRecord
      await expect(writeShadowRecords(path, [invalid])).rejects.toThrow()
      await expect(readFile(path, 'utf8')).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
