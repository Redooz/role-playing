#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RoutingContext } from '@rp/routing-policy'
import {
  createJevClient,
  createJevRoutingJudge,
  loadGoldenEntries,
  runDeterministicRoutingReplay,
  runJevRoutingReplay,
  runRoutingComparison,
  taskEntrySchema,
  writeRoutingArtifacts,
  computeRoutingArmVerdicts,
  type RoutingComparisonTask,
} from '@rp/eval-harness'
import type { GoldenEntry } from '@rp/eval-harness'
import type { RoutingOutcomeLabel } from '@rp/eval-harness'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const TASKS_ROOT = join(REPO_ROOT, 'evals/tasks/synthetic-routing/1.0.0')
const OUT = join(REPO_ROOT, 'evals/results/m3a-routing-comparison')
const DEADLINE_MS = 2_500
const MDE = 0.2
const BASELINE_ARM = 'det-central'
const COST_CAP_USD = 5

if (process.env.RUN_M3A_COMPARISON !== '1') {
  throw new Error('set RUN_M3A_COMPARISON=1 to run the live routing comparison')
}

function labelFromGolden(entry: GoldenEntry): RoutingOutcomeLabel {
  if (entry.routingOutcome === undefined) {
    throw new Error(`golden entry ${entry.id} has no routingOutcome`)
  }
  return entry.routingOutcome
}

async function loadTasks(): Promise<RoutingComparisonTask[]> {
  const golden = await loadGoldenEntries(REPO_ROOT, {
    version: '1.0.0',
    languages: ['en', 'fr'],
  })
  const labelByTask = new Map(
    golden.map((entry) => [`${entry.lang}:${entry.taskId}`, labelFromGolden(entry)]),
  )

  const tasks: RoutingComparisonTask[] = []
  for (const lang of ['en', 'fr'] as const) {
    const directory = join(TASKS_ROOT, lang)
    for (const file of (await readdir(directory)).filter((name) => name.endsWith('.json')).sort()) {
      const task = taskEntrySchema.parse(JSON.parse(await readFile(join(directory, file), 'utf8')))
      if (task.mode !== 'routing' || task.split !== 'holdout' || task.routing === undefined)
        continue
      const label = labelByTask.get(`${lang}:${task.id}`)
      if (label === undefined) throw new Error(`no routing label for holdout task ${task.id}`)
      tasks.push({
        taskId: task.id,
        lang,
        context: task.routing.context,
        label,
      })
    }
  }
  return tasks
}

function totalCost(
  artifactsByArm: Readonly<Record<string, readonly { observation: unknown }[]>>,
): number | null {
  let total = 0
  for (const artifacts of Object.values(artifactsByArm)) {
    for (const artifact of artifacts) {
      const observation = artifact.observation as {
        central?: { exact?: { usage?: { cost?: number } } }
        personas?: Record<string, { exact?: { usage?: { cost?: number } } }>
      }
      const batches = [
        ...(observation.central?.exact === undefined ? [] : [observation.central.exact]),
        ...Object.values(observation.personas ?? {}).map((entry) => entry.exact),
      ].filter((batch): batch is { usage?: { cost?: number } } => batch !== undefined)
      for (const batch of batches) {
        if (batch.usage?.cost === undefined) return null
        total += batch.usage.cost
      }
    }
  }
  return total
}

const apiKey = process.env.OPENROUTER_API_KEY
if (apiKey === undefined || apiKey.trim() === '') {
  throw new Error('OPENROUTER_API_KEY is required for the live routing comparison')
}

const tasks = await loadTasks()
const client = createJevClient({ apiKey, cache: false })
const judge = createJevRoutingJudge(client)
const seed = 20261109

const detArm = (topology: 'central_selection' | 'persona_requests') => ({
  armId: topology === 'central_selection' ? 'det-central' : 'det-persona',
  arm: { topology, judgmentSource: 'deterministic' as const },
  async run(context: RoutingContext) {
    return runDeterministicRoutingReplay(context, topology, seed)
  },
})

const jevArm = (topology: 'central_selection' | 'persona_requests') => ({
  armId: topology === 'central_selection' ? 'jev-central' : 'jev-persona',
  arm: { topology, judgmentSource: 'jev' as const },
  async run(context: RoutingContext) {
    return runJevRoutingReplay(context, topology, judge, {
      seed,
      deadlineMs: DEADLINE_MS,
    })
  },
})

const run = await runRoutingComparison(tasks, [
  detArm('central_selection'),
  detArm('persona_requests'),
  jevArm('central_selection'),
  jevArm('persona_requests'),
])

const costUsd = totalCost(run.artifactsByArm)
if (costUsd === null) {
  throw new Error('routing comparison cost is unknown; refusing to accept the $5 cap check')
}
if (costUsd > COST_CAP_USD) {
  throw new Error(
    `routing comparison cost $${costUsd.toFixed(6)} exceeded the $${COST_CAP_USD} cap`,
  )
}

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
for (const [armId, artifacts] of Object.entries(run.artifactsByArm)) {
  await writeRoutingArtifacts(join(OUT, 'artifacts', `${armId}.jsonl`), artifacts)
}

const verdicts = computeRoutingArmVerdicts(run.matrix, BASELINE_ARM, MDE)
const comparison = {
  schemaVersion: 1,
  suite: 'm3a-routing-comparison',
  split: 'holdout',
  tasks: tasks.length,
  baselineArm: BASELINE_ARM,
  minimumDetectableEffect: MDE,
  deadlineMs: DEADLINE_MS,
  costUsd,
  costCapUsd: COST_CAP_USD,
  noWinnerSelected: true,
  note: 'Complete four-arm comparison only. No routing policy is adopted by M3a.',
  matrix: run.matrix,
  verdicts,
}
await writeFile(join(OUT, 'matrix.json'), `${JSON.stringify(run.matrix, null, 2)}\n`, 'utf8')
await writeFile(join(OUT, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`, 'utf8')

console.table(
  run.matrix.arms.map((arm) => ({
    arm: arm.armId,
    lang: arm.lang,
    n: arm.n,
    completed: arm.completed,
    incomplete: arm.incomplete,
    acceptableRate: arm.acceptableOutcomeRate?.toFixed(3) ?? 'n/a',
    falseSpeakRate: arm.falseSpeakRate?.toFixed(3) ?? 'n/a',
    falseYieldRate: arm.falseYieldRate?.toFixed(3) ?? 'n/a',
    timeoutRate: arm.timeoutFallbackRate?.toFixed(3) ?? 'n/a',
    unsettledRate: arm.unsettledFallbackRate?.toFixed(3) ?? 'n/a',
    p50: arm.latencyMs?.p50.toFixed(1) ?? 'n/a',
    p95: arm.latencyMs?.p95.toFixed(1) ?? 'n/a',
    p99: arm.latencyMs?.p99.toFixed(1) ?? 'n/a',
  })),
)
console.table(verdicts)
console.log(`comparison artifacts: ${OUT}`)
console.log(`cost: $${costUsd.toFixed(6)}`)
