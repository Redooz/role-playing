import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  createJevClient,
  createJevRoutingJudge,
  runSessionTask,
  taskEntrySchema,
  writeShadowRecords,
  type CompletionProvider,
  type ShadowRecord,
  type ShadowSummary,
} from '@rp/eval-harness'
import {
  LIVEKIT_GEMMA_MODEL,
  LIVEKIT_INFERENCE_DEFAULT_BASE_URL,
  createLiveKitInferenceTextModel,
} from '@rp/pipeline'
import { SystemClock } from '@rp/shared'

/**
 * M3b shadow comparison, eval only.
 *
 * Runs the det-persona control arm over the holdout tasks and records the three
 * non-live arms after each user turn. Shadow records cannot change a session
 * event; they go to `shadow.jsonl` and a summary. No policy is adopted.
 */
const REPO_ROOT = resolve(new URL('../../../', import.meta.url).pathname)
const TASKS_ROOT = join(REPO_ROOT, 'evals/tasks/synthetic-multi-persona-session/m3b-v1')
const RESULTS_ROOT = join(REPO_ROOT, 'evals/results/m3b-shadow')
const CURRENT_DATE = '2026-11-12'
const SEED = 20261112
const DEADLINE_MS = 2_500
const COST_CAP_USD = 5

function env(name: string): string {
  const value = process.env[name]?.trim()
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

function liveProvider(): CompletionProvider {
  const model = createLiveKitInferenceTextModel({
    apiKey: env('LIVEKIT_API_KEY'),
    apiSecret: env('LIVEKIT_API_SECRET'),
    model: LIVEKIT_GEMMA_MODEL,
    baseUrl: process.env['LIVEKIT_INFERENCE_URL']?.trim() || LIVEKIT_INFERENCE_DEFAULT_BASE_URL,
  })
  return {
    kind: 'live',
    label: model.label,
    complete(request, options) {
      return model.complete(
        {
          messages: request.messages,
          ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        },
        options,
      )
    },
    dispose() {
      return model.dispose?.()
    },
  }
}

async function loadHoldoutTasks() {
  const tasks = []
  for (const lang of ['en', 'fr'] as const) {
    const directory = join(TASKS_ROOT, lang)
    const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort()
    for (const file of files) {
      const task = taskEntrySchema.parse(JSON.parse(await readFile(join(directory, file), 'utf8')))
      if (task.split === 'holdout') tasks.push(task)
    }
  }
  return tasks
}

function costOf(records: readonly ShadowRecord[]): number {
  return records.reduce((total, record) => total + (record.usage?.costUsd ?? 0), 0)
}

function aggregate(tasks: readonly { taskId: string; summary: ShadowSummary }[]) {
  const arms = new Map<
    string,
    { records: number; agreements: number; disagreements: number; costUsd: number }
  >()
  for (const entry of tasks) {
    for (const arm of entry.summary.arms) {
      const current = arms.get(arm.arm) ?? {
        records: 0,
        agreements: 0,
        disagreements: 0,
        costUsd: 0,
      }
      current.records += arm.records
      current.agreements += arm.agreements
      current.disagreements += arm.disagreements
      current.costUsd += arm.usage?.costUsd ?? 0
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
    costUsd: value.costUsd,
  }))
}

async function main(): Promise<void> {
  const apiKey = env('OPENROUTER_API_KEY')
  const judge = createJevRoutingJudge(createJevClient({ apiKey, cache: false }))
  const tasks = await loadHoldoutTasks()
  const records: ShadowRecord[] = []
  const summaries: { taskId: string; summary: ShadowSummary }[] = []

  await rm(join(RESULTS_ROOT, 'shadow.jsonl'), { force: true })
  await mkdir(RESULTS_ROOT, { recursive: true })

  for (const task of tasks) {
    const provider = liveProvider()
    try {
      const result = await runSessionTask({
        runId: 'm3b-shadow',
        executionId: `${task.id}-shadow`,
        task,
        clock: new SystemClock(),
        provider,
        wallNow: () => Date.now(),
        currentDate: CURRENT_DATE,
        promptStyle: 'gemma',
        policy: 'det-persona',
        shadow: { judge, seed: SEED, deadlineMs: DEADLINE_MS },
      })
      if (result.shadow === undefined) throw new Error(`task ${task.id} produced no shadow records`)
      records.push(...result.shadow.records)
      summaries.push({ taskId: task.id, summary: result.shadow.summary })
      await writeShadowRecords(join(RESULTS_ROOT, 'shadow.jsonl'), result.shadow.records)
      const totalCost = costOf(records)
      if (totalCost >= COST_CAP_USD) {
        throw new Error(`shadow cost $${totalCost.toFixed(4)} reached the $${COST_CAP_USD} cap`)
      }
      console.log(
        `${task.id}: ${result.shadow.records.length} records, total cost $${totalCost.toFixed(4)}`,
      )
    } finally {
      await provider.dispose?.()
    }
  }

  const combined = {
    schemaVersion: 1,
    suite: 'm3b-shadow',
    note: 'Eval-only shadow comparison over holdout tasks. No policy is adopted.',
    seed: SEED,
    deadlineMs: DEADLINE_MS,
    records: records.length,
    costUsd: costOf(records),
    arms: aggregate(summaries),
    tasks: summaries,
    generatedAt: new Date().toISOString(),
  }
  await writeFile(
    join(RESULTS_ROOT, 'summary.json'),
    `${JSON.stringify(combined, null, 2)}\n`,
    'utf8',
  )
  console.log(`shadow summary: ${join(RESULTS_ROOT, 'summary.json')}`)
}

await main()
