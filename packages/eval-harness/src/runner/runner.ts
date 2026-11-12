import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { SystemClock, createSeededRandom, sha256Hex, type SeededRandom } from '@rp/shared'
import {
  checkTranscriptSequence,
  eventFromTranscriptRecord,
  expectedContentClass,
  guardTurnEvents,
  isSessionEventName,
  type SessionEvent,
  type TranscriptRecord,
  type Violation,
} from '@rp/session-core'
import { taskEntrySchema, type TaskEntry, type Lang } from '../tasks/schema.js'
import { goldenIndexByTask, loadGoldenEntries } from '../tasks/golden.js'
import {
  CannedProviderMissError,
  ProviderUnavailableError,
  createCannedProvider,
  createLiveProvider,
} from './canned-provider.js'
import {
  manifestHash,
  parseManifest,
  type TaskSelection,
  type InvariantResult,
  type ManifestIssue,
  type RunManifest,
} from './manifest.js'
import { buildCannedEntriesForTask, replayTask, ReplayError } from './replay.js'
import {
  GENERIC_PROMPT_TEMPLATE_VERSION,
  SESSION_PROMPT_TEMPLATE_VERSIONS,
  buildSessionCannedEntries,
  runSessionTask,
} from './session-runner.js'
import { speechMetricsFromRecords } from './speech.js'
import { computePassMetrics } from './pass-k.js'
import {
  RUN_RESULT_SCHEMA_VERSION,
  buildVersions,
  metricReadingsSchema,
  parseRunResult,
  transcriptRelativePath,
  type MetricReadings,
  type TrialOutcome,
  type RunResult,
  type RunSummary,
} from './results.js'
import {
  createDeterministicInvariantGrader,
  type Grader,
  type SemanticGrade,
  type TrialRecord,
} from './grader.js'
import {
  TrialTimeoutError,
  createTrialEnvironment,
  settleWithin,
  snapshotEnvironment,
  withTrialTimeout,
  type ProviderFactory,
  type TrialEnvironment,
} from './trial.js'
import { computeVerdict, type RunVerdict } from './verdict.js'
import { deriveExecutionId } from '../observability/execution-id.js'

/**
 * Simulated-time evaluation harness (M0 D3).
 *
 * Executes the manifest's rounds over the selected tasks, using a fresh
 * `FakeClock` per task so simulated time always starts at zero. The harness
 * computes invariants itself, asks an injected grader for per-axis metrics and
 * then asks the pure verdict function for the decision. It never infers a
 * verdict from feature code and never turns a failed trial into a zero.
 *
 * File writing is deliberately left to the CLI: `executeRun` returns the result
 * artifact and the normalized transcripts in memory.
 */

export class HarnessConfigError extends Error {
  readonly issues: readonly ManifestIssue[]

  constructor(message: string, issues: readonly ManifestIssue[] = []) {
    super(message)
    this.name = 'HarnessConfigError'
    this.issues = issues
  }
}

export interface LoadedTask {
  readonly task: TaskEntry
  /** Path relative to the repository root, using `/` separators. */
  readonly relativePath: string
}

/** Cleanup may not take longer than this; a stuck dispose fails the trial. */
const DISPOSE_TIMEOUT_MS = 5_000

export interface ExecuteRunOptions {
  /** Repository root: the directory containing `evals/`. */
  readonly repoRoot: string
  /** Raw manifest (validated here) or an already-parsed manifest. */
  readonly manifest: unknown
  /** Grading port. Defaults to the deterministic invariant grader. */
  readonly grader?: Grader
  /**
   * Builds a fresh provider for every trial. Defaults to the manifest's
   * provider mode. Tests inject a factory to prove no instance is shared.
   */
  readonly providerFactory?: ProviderFactory
  /** Wall clock used only for run metadata and `tWall`. */
  readonly wallClock?: () => number
  /** Code SHA to stamp into the result, when the caller can resolve one. */
  readonly codeSha?: string
  /** Per-trial wall-clock budget. Defaults to 30 seconds. */
  readonly trialTimeoutMs?: number
}

export interface TrialTranscriptFile {
  readonly taskId: string
  readonly lang: Lang
  readonly round: number
  readonly relativePath: string
  readonly jsonl: string
  readonly sha256: string
  /** The same records the JSONL encodes, kept in memory for observability. */
  readonly records: readonly TranscriptRecord[]
}

export interface EvaluationRun {
  readonly result: RunResult
  readonly transcripts: readonly TrialTranscriptFile[]
  /** Loaded tasks, so exporters can attach task metadata without re-reading disk. */
  readonly tasks: readonly LoadedTask[]
  /** Raw semantic judgments from the injected grader, when it produced any. */
  readonly gradeDetails: readonly SemanticGrade[]
}

/**
 * Load and validate the tasks selected by the manifest.
 *
 * Every file is parsed against `taskEntrySchema`; a malformed task is a
 * configuration error, not a failed measurement. Each requested language must
 * contribute at least one task (§4.4: passing EN does not count for FR).
 */
export async function loadSelectedTasks(
  repoRoot: string,
  selection: TaskSelection,
): Promise<LoadedTask[]> {
  const root = resolve(repoRoot)
  const selected: LoadedTask[] = []
  const requestedLocales = new Set(selection.locales ?? selection.languages)

  for (const lang of selection.languages) {
    const directory = join(root, 'evals', 'tasks', selection.dataset, selection.version, lang)
    const files = await collectJsonFiles(directory)

    if (files.length === 0) {
      throw new HarnessConfigError(
        `no tasks found for language "${lang}" at evals/tasks/${selection.dataset}/${selection.version}/${lang}`,
      )
    }

    for (const file of files) {
      const relativePath = relative(root, file).split(sep).join('/')
      const task = await readTask(file, relativePath)

      if (task.lang !== lang) {
        throw new HarnessConfigError(
          `task ${relativePath} declares lang "${task.lang}" but lives under "${lang}"`,
        )
      }

      if (selection.splits !== undefined && !selection.splits.includes(task.split)) continue
      if (selection.ids !== undefined && !selection.ids.includes(task.id)) continue
      if (!requestedLocales.has(task.locale ?? task.lang)) continue

      selected.push({ task, relativePath })
    }
  }

  const seen = new Set<string>()
  for (const { task } of selected) {
    const key = `${task.lang}\u0000${task.locale ?? task.lang}\u0000${task.id}`
    if (seen.has(key)) {
      throw new HarnessConfigError(
        `task id "${task.id}" appears more than once in language "${task.lang}" locale "${task.locale ?? task.lang}"`,
      )
    }
    seen.add(key)
  }

  for (const lang of selection.languages) {
    if (!selected.some(({ task }) => task.lang === lang)) {
      throw new HarnessConfigError(
        `manifest selects no task for language "${lang}" after split/id/locale filters`,
      )
    }
  }

  for (const locale of requestedLocales) {
    if (!selected.some(({ task }) => (task.locale ?? task.lang) === locale)) {
      throw new HarnessConfigError(
        `manifest selects no task for locale "${locale}" after split/id filters`,
      )
    }
  }

  const languageOrder = new Map<Lang, number>(
    selection.languages.map((lang, index) => [lang, index]),
  )

  return selected.sort((left, right) => {
    const leftOrder = languageOrder.get(left.task.lang) ?? 0
    const rightOrder = languageOrder.get(right.task.lang) ?? 0
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    return compareStrings(left.task.id, right.task.id)
  })
}

/** Execute every registered round and build the result artifact. */
export async function executeRun(options: ExecuteRunOptions): Promise<EvaluationRun> {
  const manifest = parseManifest(options.manifest)
  const grader = options.grader ?? createDeterministicInvariantGrader()
  assertGraderMatchesManifest(grader, manifest)

  const wallClock = options.wallClock ?? (() => new SystemClock().now())
  const startedAt = new Date(wallClock()).toISOString()
  const executionId = deriveExecutionId(manifest.run.runId, startedAt)

  const tasks = await loadSelectedTasks(options.repoRoot, manifest.tasks)
  assertSessionPrompt(manifest, tasks)
  const goldens = goldenIndexByTask(
    await loadGoldenEntries(options.repoRoot, {
      version: manifest.tasks.version,
      languages: manifest.tasks.languages,
    }),
  )
  const providerFactory = options.providerFactory ?? createProviderFactory(manifest, tasks)

  const rng = createSeededRandom(manifest.seeds.master)
  const orderedTasks = shuffled(tasks, rng)

  const trials: TrialRecord[] = []
  const transcripts: TrialTranscriptFile[] = []
  let failedRounds = 0

  for (let round = 0; round < manifest.limits.rounds; round += 1) {
    let roundFailed = false

    for (const { task } of orderedTasks) {
      let environment: TrialEnvironment | undefined
      const environmentSnapshot = snapshotEnvironment()
      let disposeFailure: unknown

      try {
        environment = createTrialEnvironment({
          masterSeed: manifest.seeds.master,
          round,
          task,
          providerFactory,
          ...(options.trialTimeoutMs === undefined
            ? task.mode === 'session'
              ? { timeoutMs: 180_000 }
              : {}
            : { timeoutMs: options.trialTimeoutMs }),
        })
        const trial = environment

        const replayed: { records: readonly TranscriptRecord[]; jsonl: string } =
          await withTrialTimeout(
            trial,
            (signal): Promise<{ records: readonly TranscriptRecord[]; jsonl: string }> => {
              if (trial.task.mode === 'session') {
                const currentDate = manifest.prompt?.currentDate
                if (currentDate === undefined) {
                  throw new HarnessConfigError(
                    'a session task requires manifest.prompt.currentDate',
                  )
                }
                return runSessionTask({
                  runId: manifest.run.runId,
                  executionId,
                  task: trial.task,
                  clock: trial.clock,
                  provider: trial.provider,
                  wallNow: wallClock,
                  currentDate,
                  promptMode: manifest.prompt?.mode ?? 'persona',
                  promptStyle: manifest.prompt?.style ?? 'harmony',
                  ...(manifest.multiPersona === undefined
                    ? {}
                    : { policy: manifest.multiPersona.policy }),
                  signal,
                })
              }

              return replayTask({
                runId: manifest.run.runId,
                executionId,
                task: trial.task,
                clock: trial.clock,
                provider: trial.provider,
                wallNow: wallClock,
                signal,
              })
            },
          )

        const events: SessionEvent[] = []
        for (const record of replayed.records) {
          const event = eventFromTranscriptRecord(record)
          if (event === undefined) {
            throw new HarnessConfigError(
              `transcript record kind "${record.kind}" is not a §2.1 event; the replay path cannot emit it`,
            )
          }
          events.push(event)
        }

        const guard = guardTurnEvents(events)
        const sequence = checkTranscriptSequence(replayed.records)
        const contentClassValid = replayed.records.every((record) => {
          if (!isSessionEventName(record.kind)) return false
          return record.contentClass === expectedContentClass(record.kind)
        })

        const relativePath = transcriptRelativePath(round, task.lang, task.id)
        const sha256 = sha256Hex(replayed.jsonl)

        trials.push({
          round,
          taskId: task.id,
          lang: task.lang,
          ok: true,
          records: replayed.records,
          jsonl: replayed.jsonl,
          transcriptSha256: sha256,
          transcriptPath: relativePath,
          violations: guard.violations,
          schemaValid: true,
          sequenceValid: sequence.ok,
          contentClassValid,
          providerOutage: false,
          speech: speechMetricsFromRecords(replayed.records),
          task: trial.task,
          ...(goldens.get(`${task.lang}:${task.id}`) === undefined
            ? {}
            : { golden: goldens.get(`${task.lang}:${task.id}`)! }),
        })

        transcripts.push({
          taskId: task.id,
          lang: task.lang,
          round,
          relativePath,
          jsonl: replayed.jsonl,
          sha256,
          records: replayed.records,
        })
      } catch (error) {
        if (error instanceof CannedProviderMissError) {
          throw new HarnessConfigError(
            `canned replay is missing a recorded response (${error.message}); refusing to fall back`,
          )
        }

        if (error instanceof ReplayError) {
          throw new HarnessConfigError(`replay failure: ${error.message}`)
        }

        trials.push(failedTrial(round, task, error))
        roundFailed = true
      } finally {
        if (environment !== undefined) {
          try {
            await settleWithin(
              environment.dispose(),
              DISPOSE_TIMEOUT_MS,
              `trial ${environment.trialId} cleanup exceeded ${DISPOSE_TIMEOUT_MS} ms`,
            )
          } catch (error) {
            disposeFailure = error
          }
        }
        environmentSnapshot.restore()
      }

      if (disposeFailure !== undefined) {
        roundFailed = true
        const index = trials.findLastIndex(
          (trial) => trial.round === round && trial.taskId === task.id && trial.lang === task.lang,
        )
        const failed = failedTrial(round, task, disposeFailure)
        if (index === -1) trials.push(failed)
        else trials[index] = failed
      }
    }

    if (roundFailed) failedRounds += 1
  }

  const metrics = await score(manifest, grader, trials)
  const gradeDetails =
    grader.details === undefined ? [] : await grader.details({ manifest, trials })
  const passMetrics = computePassMetrics(passTrials(trials, gradeDetails), 3)
  const invariants = computeInvariants(manifest, trials)
  const summary = summarize(manifest, trials, failedRounds)
  const providerOutages = trials.filter((trial) => trial.providerOutage).length

  const verdict: RunVerdict = computeVerdict({
    manifest,
    metrics,
    rounds: {
      requested: manifest.limits.rounds,
      attempts: summary.attempts,
      completed: summary.completed,
    },
    invariants,
    providerOutages,
  })

  const result: RunResult = {
    schemaVersion: RUN_RESULT_SCHEMA_VERSION,
    runId: manifest.run.runId,
    suite: manifest.run.suite,
    manifestHash: manifestHash(manifest),
    manifest,
    verdict,
    metrics,
    invariants,
    passMetrics,
    trials: trials.map(toTrialOutcome),
    transcripts: transcripts.map((transcript) => ({
      taskId: transcript.taskId,
      lang: transcript.lang,
      round: transcript.round,
      path: transcript.relativePath,
      sha256: transcript.sha256,
    })),
    summary,
    versions: buildVersions({ manifest, codeSha: options.codeSha }),
    startedAt,
    finishedAt: new Date(wallClock()).toISOString(),
  }

  // Parse the artifact we are about to persist: a result that does not satisfy
  // its own schema must never reach disk.
  return { result: parseRunResult(result), transcripts, tasks: orderedTasks, gradeDetails }
}

function assertGraderMatchesManifest(grader: Grader, manifest: RunManifest): void {
  if (
    grader.id !== manifest.grader.id ||
    grader.kind !== manifest.grader.kind ||
    grader.version !== manifest.grader.version
  ) {
    throw new HarnessConfigError(
      `grader mismatch: manifest registers "${manifest.grader.id}" (${manifest.grader.kind}) version "${manifest.grader.version}" but the injected grader is "${grader.id}" (${grader.kind}) version "${grader.version}"`,
    )
  }
  if (grader.kind === 'system-one-model' && grader.rubricVersion === undefined) {
    throw new HarnessConfigError(
      `grader "${grader.id}" is a system-one-model grader but declares no rubric; the manifest's rubric cannot be checked`,
    )
  }
  if (grader.rubricVersion !== undefined && grader.rubricVersion !== manifest.rubric.version) {
    throw new HarnessConfigError(
      `rubric mismatch: manifest registers rubric "${manifest.rubric.version}" but grader "${grader.id}" implements "${grader.rubricVersion}"`,
    )
  }
}

function assertSessionPrompt(manifest: RunManifest, tasks: readonly LoadedTask[]): void {
  const sessionTasks = tasks.filter(({ task }) => task.mode === 'session')
  if (sessionTasks.length === 0) return

  const prompt = manifest.prompt
  if (prompt === undefined) {
    throw new HarnessConfigError(
      'a manifest selecting session tasks must register prompt.currentDate so the prompt is reproducible',
    )
  }
  if (prompt.version !== undefined) {
    const style = prompt.style ?? 'harmony'
    const expected =
      prompt.mode === 'generic'
        ? GENERIC_PROMPT_TEMPLATE_VERSION
        : SESSION_PROMPT_TEMPLATE_VERSIONS[style]
    if (prompt.version !== expected) {
      throw new HarnessConfigError(
        `manifest prompt version "${prompt.version}" does not match the ${prompt.mode ?? 'persona'} template "${expected}"`,
      )
    }
  }
  for (const { task } of sessionTasks) {
    if (task.session === undefined) {
      throw new HarnessConfigError(`session task ${task.id} has no session block`)
    }
    if ((task.session.personaIds?.length ?? 1) > 1 && manifest.multiPersona === undefined) {
      throw new HarnessConfigError(
        `multi-persona session task ${task.id} requires a registered multiPersona policy`,
      )
    }
  }
}

function createProviderFactory(
  manifest: RunManifest,
  tasks: readonly LoadedTask[],
): ProviderFactory {
  if (manifest.provider.mode === 'live') {
    return () => createLiveProvider(manifest.provider.label)
  }

  const currentDate = manifest.prompt?.currentDate
  const style = manifest.prompt?.style ?? 'harmony'
  const entries = tasks.flatMap(({ task }) => {
    if (task.mode === 'session') {
      if (currentDate === undefined) {
        throw new HarnessConfigError(
          `canned session replay for ${task.id} requires manifest.prompt.currentDate`,
        )
      }
      return buildSessionCannedEntries(task, currentDate, style, manifest.prompt?.mode ?? 'persona')
    }
    return buildCannedEntriesForTask(task)
  })
  // Validate the recorded bundle once, before any trial runs. A bad bundle is a
  // configuration error, not a failed trial. Each trial still gets a fresh
  // provider instance.
  createCannedProvider(entries, manifest.provider.label)
  return () => createCannedProvider(entries, manifest.provider.label)
}

async function score(
  manifest: RunManifest,
  grader: Grader,
  trials: readonly TrialRecord[],
): Promise<MetricReadings> {
  let raw: Readonly<Record<string, number>>
  try {
    raw = await grader.score({ manifest, trials })
  } catch (error) {
    throw new HarnessConfigError(
      `grader "${grader.id}" failed: ${errorMessage(error)}; a failed grader call is never a score`,
    )
  }

  const parsed = metricReadingsSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HarnessConfigError(
      `grader "${grader.id}" returned invalid metric readings: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    )
  }

  const registered = [manifest.target.metric, ...manifest.guardrails.map((guard) => guard.metric)]
  const missing = registered.filter((metric) => parsed.data[metric] === undefined)
  if (missing.length > 0) {
    throw new HarnessConfigError(
      `grader "${grader.id}" did not measure registered axis(es): ${missing.join(', ')}`,
    )
  }

  return parsed.data
}

function computeInvariants(
  manifest: RunManifest,
  trials: readonly TrialRecord[],
): InvariantResult[] {
  const completed = trials.filter((trial) => trial.ok)
  const registered = new Set(manifest.invariants)
  const results: InvariantResult[] = []

  const add = (id: InvariantResult['id'], ok: boolean, detail: string): void => {
    if (registered.has(id)) results.push({ id, ok, detail })
  }

  const nothingCompleted = completed.length === 0
  const noDataDetail = 'no completed trial to evaluate'

  add(
    'transcript.schema_valid',
    !nothingCompleted && completed.every((trial) => trial.schemaValid),
    nothingCompleted
      ? noDataDetail
      : `all ${completed.length} completed transcripts parse against the transcript schema`,
  )

  const violations: readonly Violation[] = completed.flatMap((trial) => trial.violations)

  add(
    'transcript.guard_clean',
    !nothingCompleted && violations.length === 0,
    nothingCompleted
      ? noDataDetail
      : `${violations.length} §3.2 guard violation(s) across completed transcripts`,
  )

  add(
    'transcript.seq_monotonic',
    !nothingCompleted && completed.every((trial) => trial.sequenceValid),
    nothingCompleted ? noDataDetail : 'every completed transcript has strictly increasing seq',
  )

  add(
    'transcript.content_class',
    !nothingCompleted && completed.every((trial) => trial.contentClassValid),
    nothingCompleted
      ? noDataDetail
      : 'every text-bearing record is restricted and operational records are contentFree',
  )

  const speech = completed.map((trial) => trial.speech)
  add(
    'response.plain_text',
    !nothingCompleted &&
      speech.every(
        (metrics) =>
          metrics !== undefined &&
          metrics.plainTextRate === 1 &&
          metrics.emojiCount === 0 &&
          metrics.markdownCount === 0 &&
          metrics.emptyResponses === 0,
      ),
    nothingCompleted
      ? noDataDetail
      : 'every completed reply is plain text with no Markdown, no emoji and no empty reply',
  )

  return results
}

function summarize(
  manifest: RunManifest,
  trials: readonly TrialRecord[],
  failedRounds: number,
): RunSummary {
  const attempts = manifest.limits.rounds
  const failed = failedRounds
  const completed = attempts - failed

  return {
    requestedRounds: manifest.limits.rounds,
    attempts,
    completed,
    failed,
    failureRate: attempts === 0 ? 1 : failed / attempts,
    trials: trials.length,
    failedTrials: trials.filter((trial) => !trial.ok).length,
  }
}

/**
 * Reduce each trial to the binary outcome `pass^k` needs.
 *
 * A completed trial passes when every semantic axis it was judged on clears the
 * pre-registered line. A trial with no semantic details (a replay suite) uses
 * the harness outcome alone.
 */
function passTrials(
  trials: readonly TrialRecord[],
  details: readonly SemanticGrade[],
): Array<{ round: number; taskId: string; lang: string; passed: boolean }> {
  const byTrial = new Map<string, SemanticGrade[]>()
  for (const detail of details) {
    const rows = byTrial.get(detail.trialId) ?? []
    rows.push(detail)
    byTrial.set(detail.trialId, rows)
  }

  return trials.map((trial) => {
    const rows = byTrial.get(`${trial.round}:${trial.lang}:${trial.taskId}`)
    const semanticPass =
      rows === undefined || rows.length === 0
        ? true
        : rows.every((row) => row.probability >= row.threshold)
    return {
      round: trial.round,
      taskId: trial.taskId,
      lang: trial.lang,
      passed: trial.ok && semanticPass,
    }
  })
}

function failedTrial(round: number, task: TaskEntry, error: unknown): TrialRecord {
  return {
    round,
    taskId: task.id,
    lang: task.lang,
    ok: false,
    records: [],
    violations: [],
    schemaValid: false,
    sequenceValid: false,
    contentClassValid: false,
    error: errorMessage(error),
    providerOutage: error instanceof ProviderUnavailableError || error instanceof TrialTimeoutError,
    task,
  }
}

function toTrialOutcome(trial: TrialRecord): TrialOutcome {
  const last = trial.records.at(-1)

  return {
    round: trial.round,
    taskId: trial.taskId,
    lang: trial.lang,
    ok: trial.ok,
    records: trial.records.length,
    ...(trial.transcriptSha256 === undefined ? {} : { transcriptSha256: trial.transcriptSha256 }),
    ...(trial.transcriptPath === undefined ? {} : { transcriptPath: trial.transcriptPath }),
    ...(last === undefined ? {} : { simDurationMs: last.tSim }),
    ...(trial.error === undefined ? {} : { error: trial.error }),
    providerOutage: trial.providerOutage,
  }
}

async function readTask(path: string, relativePath: string): Promise<TaskEntry> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    throw new HarnessConfigError(`cannot read task ${relativePath}: ${errorMessage(error)}`)
  }

  const parsed = taskEntrySchema.safeParse(raw)
  if (!parsed.success) {
    throw new HarnessConfigError(
      `task ${relativePath} is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    )
  }

  return parsed.data
}

async function collectJsonFiles(directory: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw new HarnessConfigError(`cannot read task directory ${directory}: ${errorMessage(error)}`)
  }

  const files: string[] = []
  for (const entry of [...entries].sort((left, right) => compareStrings(left.name, right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectJsonFiles(path)))
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(path)
    }
  }

  return files.sort(compareStrings)
}

function shuffled<T>(items: readonly T[], rng: SeededRandom): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = rng.int(index + 1)
    const current = copy[index]
    const swap = copy[swapIndex]
    if (current === undefined || swap === undefined) continue
    copy[index] = swap
    copy[swapIndex] = current
  }
  return copy
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
