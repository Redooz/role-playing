import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import {
  FakeClock,
  SystemClock,
  createSeededRandom,
  sha256Hex,
  type SeededRandom,
} from '@rp/shared'
import {
  checkTranscriptSequence,
  eventFromTranscriptRecord,
  guardTurnEvents,
  isSessionEventName,
  type SessionEvent,
  type Violation,
} from '@rp/session-core'
import { taskEntrySchema, type TaskEntry, type Lang } from '../tasks/schema.js'
import {
  CannedProviderMissError,
  ProviderUnavailableError,
  createCannedProvider,
  createLiveProvider,
  type CompletionProvider,
} from './canned-provider.js'
import {
  manifestHash,
  parseManifest,
  type TaskSelection,
  type InvariantResult,
  type ManifestIssue,
  type RunManifest,
} from './manifest.js'
import {
  buildCannedEntriesForTask,
  expectedContentClass,
  replayTask,
  ReplayError,
} from './replay.js'
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
import { createDeterministicInvariantGrader, type Grader, type TrialRecord } from './grader.js'
import { computeVerdict, type RunVerdict } from './verdict.js'

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

export interface ExecuteRunOptions {
  /** Repository root: the directory containing `evals/`. */
  readonly repoRoot: string
  /** Raw manifest (validated here) or an already-parsed manifest. */
  readonly manifest: unknown
  /** Grading port. Defaults to the deterministic invariant grader. */
  readonly grader?: Grader
  /** Wall clock used only for run metadata and `tWall`. */
  readonly wallClock?: () => number
  /** Code SHA to stamp into the result, when the caller can resolve one. */
  readonly codeSha?: string
}

export interface TrialTranscriptFile {
  readonly taskId: string
  readonly lang: Lang
  readonly round: number
  readonly relativePath: string
  readonly jsonl: string
  readonly sha256: string
}

export interface EvaluationRun {
  readonly result: RunResult
  readonly transcripts: readonly TrialTranscriptFile[]
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

      selected.push({ task, relativePath })
    }
  }

  const seen = new Set<string>()
  for (const { task } of selected) {
    const key = `${task.lang}\u0000${task.id}`
    if (seen.has(key)) {
      throw new HarnessConfigError(
        `task id "${task.id}" appears more than once in language "${task.lang}"`,
      )
    }
    seen.add(key)
  }

  for (const lang of selection.languages) {
    if (!selected.some(({ task }) => task.lang === lang)) {
      throw new HarnessConfigError(
        `manifest selects no task for language "${lang}" after split/id filters`,
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

  const tasks = await loadSelectedTasks(options.repoRoot, manifest.tasks)
  const provider = createProvider(manifest, tasks)

  const rng = createSeededRandom(manifest.seeds.master)
  const orderedTasks = shuffled(tasks, rng)

  const trials: TrialRecord[] = []
  const transcripts: TrialTranscriptFile[] = []
  let failedRounds = 0

  for (let round = 0; round < manifest.limits.rounds; round += 1) {
    let roundFailed = false

    for (const { task } of orderedTasks) {
      const clock = new FakeClock(0)

      try {
        const replayed = await replayTask({
          runId: manifest.run.runId,
          task,
          clock,
          provider,
          wallNow: wallClock,
        })

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
        })

        transcripts.push({
          taskId: task.id,
          lang: task.lang,
          round,
          relativePath,
          jsonl: replayed.jsonl,
          sha256,
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
      }
    }

    if (roundFailed) failedRounds += 1
  }

  const metrics = await score(manifest, grader, trials)
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
  return { result: parseRunResult(result), transcripts }
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
}

function createProvider(manifest: RunManifest, tasks: readonly LoadedTask[]): CompletionProvider {
  if (manifest.provider.mode === 'live') {
    return createLiveProvider(manifest.provider.label)
  }

  const entries = tasks.flatMap(({ task }) => buildCannedEntriesForTask(task))
  return createCannedProvider(entries, manifest.provider.label)
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
    providerOutage: error instanceof ProviderUnavailableError,
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
