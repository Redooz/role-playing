import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { taskEntrySchema, type ShadowRecord, type ShadowSummary } from '@rp/eval-harness'
import type { TaskEntry } from '@rp/eval-harness'

/**
 * Pure helpers for the M3b shadow run.
 *
 * A missing cost is `null`, never zero. `det-central` has `usage: null` because
 * it makes no model call; a Jev record with `usage: null` or `costUsd: null` is
 * unknown and makes the total unknown.
 */
export function costOf(records: readonly ShadowRecord[]): number | null {
  let total = 0
  for (const record of records) {
    if (record.usage === null) {
      if (record.arm === 'det-central') continue
      return null
    }
    if (record.usage.costUsd === null) return null
    total += record.usage.costUsd
  }
  return total
}

export interface ShadowArmAggregate {
  readonly arm: string
  readonly records: number
  readonly agreements: number
  readonly disagreements: number
  readonly agreementRate: number | null
  readonly costUsd: number | null
}

export function aggregate(
  tasks: readonly { readonly taskId: string; readonly summary: ShadowSummary }[],
): ShadowArmAggregate[] {
  const arms = new Map<
    string,
    {
      records: number
      agreements: number
      disagreements: number
      costUsd: number
      costUnknown: boolean
    }
  >()
  for (const entry of tasks) {
    for (const arm of entry.summary.arms) {
      const current = arms.get(arm.arm) ?? {
        records: 0,
        agreements: 0,
        disagreements: 0,
        costUsd: 0,
        costUnknown: false,
      }
      current.records += arm.records
      current.agreements += arm.agreements
      current.disagreements += arm.disagreements
      if (arm.usage?.costUsd === null || arm.usage?.costUsd === undefined) {
        if (arm.arm !== 'det-central') current.costUnknown = true
      } else {
        current.costUsd += arm.usage.costUsd
      }
      arms.set(arm.arm, current)
    }
  }
  return [...arms.entries()].map(([arm, value]) => ({
    arm,
    records: value.records,
    agreements: value.agreements,
    disagreements: value.disagreements,
    agreementRate:
      value.agreements + value.disagreements === 0
        ? null
        : value.agreements / (value.agreements + value.disagreements),
    costUsd: value.costUnknown ? null : value.costUsd,
  }))
}

/** Load the holdout tasks from one M3b task root. */
export async function loadHoldoutTasks(tasksRoot: string): Promise<TaskEntry[]> {
  const tasks: TaskEntry[] = []
  for (const lang of ['en', 'fr'] as const) {
    const directory = join(tasksRoot, lang)
    const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort()
    for (const file of files) {
      const task = taskEntrySchema.parse(JSON.parse(await readFile(join(directory, file), 'utf8')))
      if (task.split === 'holdout') tasks.push(task)
    }
  }
  return tasks
}
