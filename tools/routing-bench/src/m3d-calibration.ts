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
  type CalibrationSummary,
  type SummarySplit,
} from './m3d-calibration-summary.js'
import { armVerdict, HOLDOUT_TARGETS, selectHoldoutArm } from './m3d-holdout-verdict.js'

/**
 * M3d offline routing comparison (D3 calibration, D4 holdout).
 *
 * Rebuilds one routing context per labelled learner turn from a recorded
 * reference session, runs both Jev topology arms against it, and writes the
 * matrix, the per-family readings and the exact artifacts. Calibration iterates
 * and adopts nothing; holdout applies the pre-registered selection rule.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DATASET = 'synthetic-multi-persona-session'
const TASK_VERSION = 'm3b-v2'
const DEFAULT_RESULTS_ROOT = join(REPO_ROOT, 'evals', 'results')
const DEFAULT_DEADLINE_MS = 2500
const DEFAULT_SEED = 20261124
const LOCALES = { en: ['en', 'en-GB'], fr: ['fr', 'fr-CA'] } as const

type Lang = 'en' | 'fr'

export interface CalibrationOptions {
  readonly langs: readonly Lang[]
  readonly split: SummarySplit
  readonly rounds: number
  /**
   * Results directory of the fixed-rotation reference run per language,
   * relative to the repository root. One language may share a directory.
   */
  readonly references: Readonly<Record<Lang, string>>
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

function parseLang(raw: string): Lang {
  if (raw !== 'en' && raw !== 'fr') throw new Error(`"${raw}" is not a routing language`)
  return raw
}

function parseLangs(argv: readonly string[], split: SummarySplit): readonly Lang[] {
  const plural = flag(argv, 'langs')
  if (plural !== undefined) {
    const langs = plural.split(',').map((raw) => parseLang(raw.trim()))
    if (new Set(langs).size !== langs.length) throw new Error('--langs must not repeat a language')
    return langs
  }
  const single = flag(argv, 'lang')
  if (single === undefined) {
    throw new Error(`--lang <en|fr> is required for ${split}; use --langs en,fr for both`)
  }
  return [parseLang(single)]
}

function parseSplit(argv: readonly string[]): SummarySplit {
  const raw = flag(argv, 'split') ?? 'calibration'
  if (raw !== 'calibration' && raw !== 'holdout')
    throw new Error('--split must be "calibration" or "holdout"')
  return raw
}

function parseRounds(argv: readonly string[], split: SummarySplit): number {
  const raw = flag(argv, 'rounds')
  const rounds = positiveNumber(raw, 'rounds', split === 'holdout' ? 3 : 1)
  if (!Number.isInteger(rounds)) throw new Error('--rounds must be a whole number')
  return rounds
}

/**
 * Parse `--reference`.
 *
 * A single directory applies to every language. `en=<dir>,fr=<dir>` names one
 * per language, which is what a per-language reference run needs; every
 * requested language must then be covered exactly once.
 */
function parseReferences(
  argv: readonly string[],
  langs: readonly Lang[],
): Readonly<Record<Lang, string>> {
  const raw = flag(argv, 'reference')
  if (raw === undefined || raw.trim() === '') throw new Error('--reference <run-dir> is required')
  if (!raw.includes('=')) {
    return Object.fromEntries(langs.map((lang) => [lang, raw])) as Record<Lang, string>
  }

  const references: Partial<Record<Lang, string>> = {}
  for (const part of raw.split(',')) {
    const separator = part.indexOf('=')
    if (separator === -1) throw new Error(`--reference entry "${part}" is not <lang>=<dir>`)
    const lang = parseLang(part.slice(0, separator).trim())
    const directory = part.slice(separator + 1).trim()
    if (directory === '') throw new Error(`--reference entry "${part}" has no directory`)
    if (!langs.includes(lang)) {
      throw new Error(`--reference names "${lang}", which is not requested`)
    }
    if (references[lang] !== undefined) throw new Error(`--reference repeats "${lang}"`)
    references[lang] = directory
  }
  for (const lang of langs) {
    if (references[lang] === undefined) {
      throw new Error(`--reference has no directory for "${lang}"`)
    }
  }
  return references as Record<Lang, string>
}

export function parseOptions(argv: readonly string[]): CalibrationOptions {
  const split = parseSplit(argv)
  const langs = parseLangs(argv, split)
  // The frozen selection rule needs both languages; one alone cannot pass it.
  if (
    split === 'holdout' &&
    (langs.length !== 2 || !langs.includes('en') || !langs.includes('fr'))
  ) {
    throw new Error('a holdout selection requires both languages: --langs en,fr')
  }
  return {
    langs,
    split,
    rounds: parseRounds(argv, split),
    references: parseReferences(argv, langs),
    resultsRoot: flag(argv, 'results-root') ?? DEFAULT_RESULTS_ROOT,
    deadlineMs: positiveNumber(flag(argv, 'deadline-ms'), 'deadline-ms', DEFAULT_DEADLINE_MS),
    seed: positiveNumber(flag(argv, 'seed'), 'seed', DEFAULT_SEED),
  }
}

/**
 * Transcripts are grouped by language and round; the locale variant is in the
 * task id. A missing round is a hard error, never a shorter run.
 */
function transcriptPath(referenceDir: string, round: number, lang: string, taskId: string): string {
  return join(referenceDir, 'transcripts', `round-${round}`, lang, `${taskId}.jsonl`)
}

interface LanguageTasks {
  readonly tasks: readonly RoutingComparisonTask[]
  readonly taskCount: number
  readonly expectedContexts: number
}

/**
 * One routing task per labelled learner turn, rebuilt from the reference log.
 *
 * The reference run is the fixed rotation over the same tasks and rounds; its
 * transcripts are the recorded history, so no persona model is called again.
 */
async function comparisonTasks(
  lang: Lang,
  split: SummarySplit,
  rounds: number,
  referenceDir: string,
): Promise<LanguageTasks> {
  const loaded = await loadSelectedTasks(REPO_ROOT, {
    dataset: DATASET,
    version: TASK_VERSION,
    languages: [lang],
    locales: [...LOCALES[lang]],
    splits: [split],
  })
  const goldens = goldenIndexByTask(
    await loadGoldenEntries(REPO_ROOT, { version: TASK_VERSION, languages: [lang] }),
  )

  const tasks: RoutingComparisonTask[] = []
  let expectedContexts = 0
  for (const { task } of loaded) {
    const golden = goldens.get(`${task.lang}:${task.id}`)
    if (golden === undefined) throw new Error(`task ${task.id} has no golden entry`)
    for (let round = 0; round < rounds; round += 1) {
      expectedContexts += golden.speakerLabels?.length ?? 0
      const text = await readFile(transcriptPath(referenceDir, round, task.lang, task.id), 'utf8')
      const history = sessionHistoryFromEvents(eventsFromTranscriptJsonl(text))
      tasks.push(...calibrationTasks(task, golden, history, rounds > 1 ? { round } : {}))
    }
  }
  return { tasks, taskCount: loaded.length, expectedContexts }
}

function requiredApiKey(): string {
  const apiKey = process.env['OPENROUTER_API_KEY']
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new Error('the routing comparison requires OPENROUTER_API_KEY')
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

interface LanguageRun {
  readonly lang: Lang
  readonly summary: CalibrationSummary
  readonly run: Awaited<ReturnType<typeof runRoutingComparison>>
}

function verdictsOf(run: LanguageRun) {
  return run.run.matrix.arms.map((arm) => armVerdict(arm, HOLDOUT_TARGETS[run.lang]))
}

async function writeLanguageRun(
  directory: string,
  language: LanguageRun,
  selection: ReturnType<typeof selectHoldoutArm> | null,
): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'matrix.json'),
    `${JSON.stringify(language.run.matrix, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(directory, 'summary.json'),
    `${JSON.stringify({ ...language.summary, selection }, null, 2)}\n`,
    'utf8',
  )
  for (const [armId, artifacts] of Object.entries(language.run.artifactsByArm)) {
    await writeRoutingArtifacts(join(directory, 'routing', `${armId}.jsonl`), artifacts)
  }
}

async function writeSelection(
  directory: string,
  langs: readonly Lang[],
  selection: ReturnType<typeof selectHoldoutArm>,
  verdicts: ReadonlyMap<Lang, ReturnType<typeof verdictsOf>>,
): Promise<void> {
  const report = {
    schemaVersion: '1.0.0',
    suite: 'm3d-routing-holdout',
    langs,
    verdicts: Object.fromEntries(langs.map((lang) => [lang, verdicts.get(lang) ?? []])),
    selection,
  }
  await writeFile(join(directory, 'selection.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function printLanguage(language: LanguageRun, verdicts: ReturnType<typeof verdictsOf>): void {
  console.log(
    `\n${language.lang}: ${language.summary.contexts} contexts, ${language.summary.rounds} round(s)`,
  )
  console.table(
    language.summary.arms.map((arm) => {
      const verdict = verdicts.find((entry) => entry.armId === arm.armId)
      return {
        arm: arm.armId,
        n: arm.n,
        completed: arm.completed,
        incomplete: arm.incomplete,
        speak: arm.classes.speak.rate?.toFixed(3) ?? 'n/a',
        silence: arm.classes.silence.rate?.toFixed(3) ?? 'n/a',
        acceptable: arm.acceptableOutcomeRate?.toFixed(3) ?? 'n/a',
        p95: arm.latencyMs?.p95.toFixed(0) ?? 'n/a',
        costUsd: arm.usage.costUsd?.toFixed(5) ?? 'n/a',
        adoptable: verdict?.adoptable ?? false,
      }
    }),
  )
  for (const verdict of verdicts) {
    for (const reason of verdict.reasons) console.log(`  ${verdict.armId}: ${reason}`)
  }
  console.log(
    `invariants: ${language.summary.invariants.map((item) => `${item.id}=${item.ok}`).join(' ')}`,
  )
}

export async function main(argv: readonly string[]): Promise<void> {
  const options = parseOptions(argv)
  const arms = comparisonArms(options)

  const runs: LanguageRun[] = []
  for (const lang of options.langs) {
    const referenceDir = join(REPO_ROOT, options.references[lang])
    const { tasks, taskCount, expectedContexts } = await comparisonTasks(
      lang,
      options.split,
      options.rounds,
      referenceDir,
    )
    const run = await runRoutingComparison(tasks, arms)
    runs.push({
      lang,
      run,
      summary: calibrationSummary({
        split: options.split,
        lang,
        reference: await referenceOf(referenceDir),
        matrix: run.matrix,
        families: familyBreakdown(run.entries),
        entries: run.entries,
        tasks: taskCount,
        rounds: options.rounds,
        contexts: tasks.length,
        expectedContexts,
        selection: null,
      }),
    })
  }

  const verdicts = new Map(runs.map((run) => [run.lang, verdictsOf(run)] as const))
  const selection =
    options.split === 'holdout' ? selectHoldoutArm(runs.flatMap((run) => verdictsOf(run))) : null
  const root = join(
    options.resultsRoot,
    `m3d-${options.split}-offline${runs.length === 1 ? `-${runs[0]!.lang}` : ''}`,
  )
  if (await exists(root)) {
    throw new Error(`refusing to overwrite ${root}; pass --results-root <dir> for a second run`)
  }
  for (const run of runs) {
    const directory = runs.length === 1 ? root : join(root, run.lang)
    await writeLanguageRun(directory, run, selection)
    printLanguage(run, verdicts.get(run.lang) ?? [])
  }
  if (selection !== null) {
    await writeSelection(root, options.langs, selection, verdicts)
    console.log(`\nselection: ${selection.reason}`)
  }
  console.log(`results: ${root}`)
  process.exitCode = runs.every((run) => calibrationExitCode({ ...run.summary, selection }) === 0)
    ? 0
    : 1
}
