import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  calibrationTasks,
  createJevClient,
  createJevRoutingJudge,
  eventsFromTranscriptJsonl,
  familyBreakdown,
  goldenIndexByTask,
  loadGoldenEntries,
  loadSelectedTasks,
  runJevRoutingReplay,
  runRoutingComparison,
  sessionHistoryFromEvents,
  writeRoutingArtifacts,
  type RoutingArm,
  type RoutingComparisonArm,
  type RoutingComparisonTask,
} from '@rp/eval-harness'
import {
  calibrationExitCode,
  calibrationSummary,
  referenceReadings,
} from './m3d-calibration-summary.js'

/**
 * M3d D3 offline routing comparison on calibration histories.
 *
 * Rebuilds one routing context per labelled learner turn from a recorded
 * reference session, runs both Jev topology arms against it, and writes the
 * matrix, the per-family readings and the exact artifacts. Calibration only:
 * no holdout context is read and no policy is adopted.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DATASET = 'synthetic-multi-persona-session'
const TASK_VERSION = 'm3b-v2'
const DEFAULT_RESULTS_ROOT = join(REPO_ROOT, 'evals', 'results')
const DEFAULT_DEADLINE_MS = 2500
const DEFAULT_SEED = 20261124
const LOCALES = { en: ['en', 'en-GB'], fr: ['fr', 'fr-CA'] } as const

export interface CalibrationOptions {
  readonly lang: 'en' | 'fr'
  /** Results directory of the fixed-rotation reference run, absolute or relative. */
  readonly reference: string
  readonly resultsRoot: string
  readonly deadlineMs: number
  readonly seed: number
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

function positiveNumber(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be positive`)
  return value
}

export function parseOptions(argv: readonly string[]): CalibrationOptions {
  const lang = flag(argv, 'lang')
  if (lang !== 'en' && lang !== 'fr') throw new Error('--lang must be "en" or "fr"')
  const reference = flag(argv, 'reference')
  if (reference === undefined || reference.trim() === '') {
    throw new Error('--reference <run-dir> is required')
  }
  return {
    lang,
    reference,
    resultsRoot: flag(argv, 'results-root') ?? DEFAULT_RESULTS_ROOT,
    deadlineMs: positiveNumber(flag(argv, 'deadline-ms'), 'deadline-ms', DEFAULT_DEADLINE_MS),
    seed: positiveNumber(flag(argv, 'seed'), 'seed', DEFAULT_SEED),
  }
}

/** Transcripts are grouped by language; the locale variant is in the task id. */
function transcriptPath(referenceDir: string, lang: string, taskId: string): string {
  return join(referenceDir, 'transcripts', 'round-0', lang, `${taskId}.jsonl`)
}

/**
 * One routing task per labelled learner turn, rebuilt from the reference log.
 *
 * The reference run is the fixed rotation over the same calibration tasks; its
 * transcript is the recorded history, so no persona model is called again.
 */
async function comparisonTasks(
  lang: 'en' | 'fr',
  referenceDir: string,
): Promise<{ tasks: RoutingComparisonTask[]; expectedContexts: number }> {
  const loaded = await loadSelectedTasks(REPO_ROOT, {
    dataset: DATASET,
    version: TASK_VERSION,
    languages: [lang],
    locales: [...LOCALES[lang]],
    splits: ['calibration'],
  })
  const goldens = goldenIndexByTask(
    await loadGoldenEntries(REPO_ROOT, { version: TASK_VERSION, languages: [lang] }),
  )

  const tasks: RoutingComparisonTask[] = []
  let expectedContexts = 0
  for (const { task } of loaded) {
    const golden = goldens.get(`${task.lang}:${task.id}`)
    if (golden === undefined) throw new Error(`task ${task.id} has no golden entry`)
    expectedContexts += golden.speakerLabels?.length ?? 0
    const text = await readFile(transcriptPath(referenceDir, task.lang, task.id), 'utf8')
    const history = sessionHistoryFromEvents(eventsFromTranscriptJsonl(text))
    tasks.push(...calibrationTasks(task, golden, history))
  }
  return { tasks, expectedContexts }
}

function requiredApiKey(): string {
  const apiKey = process.env['OPENROUTER_API_KEY']
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new Error('the calibration comparison requires OPENROUTER_API_KEY')
  }
  return apiKey
}

function comparisonArms(options: CalibrationOptions): RoutingComparisonArm[] {
  // No cache: the comparison reports latency and cost, so every call must be
  // live. A cached answer would report near-zero latency and no spend.
  const judge = createJevRoutingJudge(createJevClient({ apiKey: requiredApiKey(), cache: false }))
  const arm = (armId: string, config: RoutingArm): RoutingComparisonArm => ({
    armId,
    arm: config,
    run: (context) =>
      runJevRoutingReplay(context, config.topology, judge, {
        seed: options.seed,
        deadlineMs: options.deadlineMs,
      }),
  })
  return [
    arm('jev-central', { topology: 'central_selection', judgmentSource: 'jev' }),
    arm('jev-persona', { topology: 'persona_requests', judgmentSource: 'jev' }),
  ]
}

async function referenceOf(referenceDir: string) {
  const raw = JSON.parse(await readFile(join(referenceDir, 'result.json'), 'utf8')) as {
    runId: string
    metrics?: unknown
  }
  return referenceReadings(raw.runId, raw.metrics)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return false
    throw error
  }
}

async function writeOutput(
  output: string,
  matrix: Awaited<ReturnType<typeof runRoutingComparison>>['matrix'],
  summary: ReturnType<typeof calibrationSummary>,
  artifactsByArm: Awaited<ReturnType<typeof runRoutingComparison>>['artifactsByArm'],
): Promise<void> {
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`, 'utf8')
  await writeFile(join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  for (const [armId, artifacts] of Object.entries(artifactsByArm)) {
    await writeRoutingArtifacts(join(output, 'routing', `${armId}.jsonl`), artifacts)
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  const options = parseOptions(argv)
  const referenceDir = join(REPO_ROOT, options.reference)
  const { tasks, expectedContexts } = await comparisonTasks(options.lang, referenceDir)
  const run = await runRoutingComparison(tasks, comparisonArms(options))
  const summary = calibrationSummary({
    lang: options.lang,
    reference: await referenceOf(referenceDir),
    matrix: run.matrix,
    families: familyBreakdown(run.entries),
    entries: run.entries,
    tasks: new Set(tasks.map((task) => task.taskId.split(':')[0])).size,
    contexts: tasks.length,
    expectedContexts,
  })

  const output = join(options.resultsRoot, `m3d-calibration-offline-${options.lang}`)
  if (await exists(output)) {
    throw new Error(`refusing to overwrite ${output}; pass --results-root <dir> for a second run`)
  }
  await writeOutput(output, run.matrix, summary, run.artifactsByArm)

  console.log(`calibration comparison (${options.lang}): ${tasks.length} contexts`)
  console.table(
    summary.arms.map((arm) => ({
      arm: arm.armId,
      n: arm.n,
      completed: arm.completed,
      incomplete: arm.incomplete,
      speak: arm.classes.speak.rate?.toFixed(3) ?? 'n/a',
      silence: arm.classes.silence.rate?.toFixed(3) ?? 'n/a',
      acceptable: arm.acceptableOutcomeRate?.toFixed(3) ?? 'n/a',
      p95: arm.latencyMs?.p95.toFixed(0) ?? 'n/a',
      costUsd: arm.usage.costUsd?.toFixed(5) ?? 'n/a',
    })),
  )
  console.log(`invariants: ${summary.invariants.map((item) => `${item.id}=${item.ok}`).join(' ')}`)
  console.log(`results: ${output}`)
  process.exitCode = calibrationExitCode(summary)
}
