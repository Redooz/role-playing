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

describe('M3b shadow summary helpers', () => {
  it('treats a det arm with no usage as zero and an unknown Jev cost as unknown', () => {
    expect(costOf([record()])).toBeCloseTo(0.0001)
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
})
