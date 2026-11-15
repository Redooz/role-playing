import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ShadowRecord, ShadowSummary } from '@rp/eval-harness'
import { aggregate, costOf, loadHoldoutTasks } from './m3b-shadow-summary.js'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const TASKS_ROOT = join(REPO_ROOT, 'evals/tasks/synthetic-multi-persona-session/m3b-v1')

function record(overrides: Partial<ShadowRecord> = {}): ShadowRecord {
  return {
    schemaVersion: '1.0.0',
    kind: 'routing.shadow',
    contentClass: 'restricted',
    taskId: 'task-1',
    lang: 'en',
    arm: 'jev-persona',
    policyVersion: 'm3a-jev-persona-v1',
    decision: null,
    outcome: { kind: 'infrastructure_incomplete' },
    fallbackCause: null,
    unsettled: false,
    latencyMs: 1,
    usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.0001 },
    agreement: null,
    observation: { kind: 'none' },
    ...overrides,
  }
}

function summary(
  arm: 'jev-persona' | 'det-central' | 'jev-central',
  costUsd: number | null,
): ShadowSummary {
  return {
    schemaVersion: '1.0.0',
    kind: 'routing.shadow.summary',
    contentClass: 'restricted',
    taskId: 'task-1',
    lang: 'en',
    records: 1,
    arms: [
      {
        arm,
        records: 1,
        completed: 1,
        incomplete: 0,
        speak: 1,
        yield: 0,
        agreements: 1,
        disagreements: 0,
        agreementRate: 1,
        timeoutFallbacks: 0,
        unsettledFallbacks: 0,
        latencyMs: { p50: 1, p95: 1 },
        usage: { inputTokens: 10, outputTokens: 2, costUsd },
      },
    ],
  }
}

type ShadowArm = ShadowSummary['arms'][number]

function armSummary(arm: ShadowArm['arm'], overrides: Partial<ShadowArm> = {}): ShadowArm {
  return {
    arm,
    records: 1,
    completed: 1,
    incomplete: 0,
    speak: 1,
    yield: 0,
    agreements: 1,
    disagreements: 0,
    agreementRate: 1,
    timeoutFallbacks: 0,
    unsettledFallbacks: 0,
    latencyMs: { p50: 1, p95: 1 },
    usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.0001 },
    ...overrides,
  }
}

function summaryOf(taskId: string, arms: ShadowArm[]): ShadowSummary {
  return {
    schemaVersion: '1.0.0',
    kind: 'routing.shadow.summary',
    contentClass: 'restricted',
    taskId,
    lang: 'en',
    records: arms.reduce((count, item) => count + item.records, 0),
    arms,
  }
}

describe('M3b shadow summary helpers', () => {
  it('treats a det arm with no usage as zero and an unknown Jev cost as unknown', () => {
    expect(costOf([record()])).toBe(0.0001)
    expect(costOf([record({ arm: 'det-central', usage: null })])).toBe(0)
    expect(costOf([record({ usage: null })])).toBeNull()
    expect(
      costOf([record({ usage: { inputTokens: 10, outputTokens: 2, costUsd: null } })]),
    ).toBeNull()
  })

  it('aggregates agreement per arm without inventing a denominator', () => {
    expect(aggregate([{ taskId: 'task-1', summary: summary('jev-persona', 0.0001) }])).toEqual([
      {
        arm: 'jev-persona',
        records: 1,
        agreements: 1,
        disagreements: 0,
        agreementRate: 1,
        costUsd: 0.0001,
      },
    ])
    expect(
      aggregate([{ taskId: 'task-1', summary: summary('jev-persona', null) }])[0]?.costUsd,
    ).toBeNull()
  })

  it('loads exactly the 12 holdout tasks', async () => {
    const tasks = await loadHoldoutTasks(TASKS_ROOT)
    expect(tasks).toHaveLength(12)
    expect(tasks.every((task) => task.split === 'holdout')).toBe(true)
    expect(new Set(tasks.map((task) => task.lang))).toEqual(new Set(['en', 'fr']))
  })

  it('loads holdout task ids in sorted file order, English before French', async () => {
    const tasks = await loadHoldoutTasks(TASKS_ROOT)
    expect(tasks.map((task) => task.id)).toStrictEqual([
      'en-b2-scope-en-gb-hold-311',
      'en-b2-scope-en-gb-hold-312',
      'en-b2-scope-en-gb-hold-313',
      'en-b2-scope-en-hold-301',
      'en-b2-scope-en-hold-302',
      'en-b2-scope-en-hold-303',
      'fr-b2-scope-fr-ca-hold-331',
      'fr-b2-scope-fr-ca-hold-332',
      'fr-b2-scope-fr-ca-hold-333',
      'fr-b2-scope-fr-hold-321',
      'fr-b2-scope-fr-hold-322',
      'fr-b2-scope-fr-hold-323',
    ])
  })

  it('ignores non-JSON files and calibration tasks in a task root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm3b-shadow-'))
    try {
      await mkdir(join(root, 'en'), { recursive: true })
      await mkdir(join(root, 'fr'), { recursive: true })
      await copyFile(
        join(TASKS_ROOT, 'en/en-b2-scope-en-cal-201.json'),
        join(root, 'en/en-b2-scope-en-cal-201.json'),
      )
      await writeFile(join(root, 'en/README.txt'), 'not a task')
      await expect(loadHoldoutTasks(root)).resolves.toStrictEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('costOf', () => {
  it('sums every known cost and skips a det arm without usage', () => {
    expect(
      costOf([
        record({ usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.25 } }),
        record({ arm: 'det-central', usage: null }),
        record({ arm: 'jev-central', usage: { inputTokens: 1, outputTokens: 0, costUsd: 0.5 } }),
      ]),
    ).toBe(0.75)
  })

  it('is zero for no records', () => {
    expect(costOf([])).toBe(0)
  })

  it('counts a det-central record that carries a known cost', () => {
    expect(
      costOf([
        record({
          arm: 'det-central',
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.0004 },
        }),
      ]),
    ).toBe(0.0004)
  })

  it('is unknown when any Jev record has no usage or no cost', () => {
    expect(costOf([record(), record({ arm: 'jev-central', usage: null })])).toBeNull()
    expect(
      costOf([record(), record({ usage: { inputTokens: 10, outputTokens: 2, costUsd: null } })]),
    ).toBeNull()
  })

  it('reports a single known cost exactly', () => {
    expect(costOf([record()])).toBe(0.0001)
  })
})

describe('aggregate', () => {
  it('returns no arms for no tasks', () => {
    expect(aggregate([])).toStrictEqual([])
  })

  it('sums counts and costs per arm across tasks', () => {
    const tasks = [
      {
        taskId: 'task-1',
        summary: summaryOf('task-1', [
          armSummary('jev-persona', {
            records: 3,
            completed: 3,
            agreements: 2,
            disagreements: 1,
            agreementRate: 2 / 3,
            usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.25 },
          }),
        ]),
      },
      {
        taskId: 'task-2',
        summary: summaryOf('task-2', [
          armSummary('jev-persona', {
            usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.5 },
          }),
        ]),
      },
    ]
    expect(aggregate(tasks)).toStrictEqual([
      {
        arm: 'jev-persona',
        records: 4,
        agreements: 3,
        disagreements: 1,
        agreementRate: 0.75,
        costUsd: 0.75,
      },
    ])
  })

  it('rates an arm where agreements and disagreements are equal', () => {
    const tasks = [
      {
        taskId: 'task-1',
        summary: summaryOf('task-1', [
          armSummary('jev-persona', {
            records: 4,
            completed: 4,
            agreements: 2,
            disagreements: 2,
            agreementRate: 0.5,
          }),
        ]),
      },
    ]
    expect(aggregate(tasks)[0]?.agreementRate).toBe(0.5)
  })

  it('keeps a null rate without a judged denominator', () => {
    const tasks = [
      {
        taskId: 'task-1',
        summary: summaryOf('task-1', [
          armSummary('det-central', {
            records: 2,
            completed: 2,
            speak: 1,
            yield: 1,
            agreements: 0,
            disagreements: 0,
            agreementRate: null,
            timeoutFallbacks: 2,
          }),
        ]),
      },
    ]
    expect(aggregate(tasks)).toStrictEqual([
      {
        arm: 'det-central',
        records: 2,
        agreements: 0,
        disagreements: 0,
        agreementRate: null,
        costUsd: 0.0001,
      },
    ])
  })

  it('reports an unknown cost for a Jev arm without usage but zero for det-central', () => {
    const tasks = [
      {
        taskId: 'task-1',
        summary: summaryOf('task-1', [
          armSummary('det-central', { usage: null }),
          armSummary('jev-persona', { usage: null }),
        ]),
      },
    ]
    expect(aggregate(tasks)).toStrictEqual([
      {
        arm: 'det-central',
        records: 1,
        agreements: 1,
        disagreements: 0,
        agreementRate: 1,
        costUsd: 0,
      },
      {
        arm: 'jev-persona',
        records: 1,
        agreements: 1,
        disagreements: 0,
        agreementRate: 1,
        costUsd: null,
      },
    ])
  })

  it('reports an unknown cost when a Jev usage carries a null cost', () => {
    const result = aggregate([
      {
        taskId: 'task-1',
        summary: summaryOf('task-1', [
          armSummary('jev-central', {
            usage: { inputTokens: 10, outputTokens: 2, costUsd: null },
          }),
        ]),
      },
    ])
    expect(result[0]?.costUsd).toBeNull()
  })
})
