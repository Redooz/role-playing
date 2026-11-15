import { SystemClock, createSeededRandom, sha256Hex, type SeededRandom } from '@rp/shared'
import {
  checkTranscriptSequence,
  eventFromTranscriptRecord,
  expectedContentClass,
  guardTurnEvents,
  isSessionEventName,
  type SessionEvent,
  type TranscriptRecord,
} from '@rp/session-core'
import type { Lang } from '../tasks/schema.js'
import { goldenIndexByTask, loadGoldenEntries } from '../tasks/golden.js'
import { CannedProviderMissError } from './canned-provider.js'
import { assertCompositionCoversSelection } from './composition-guard.js'
import { HarnessConfigError } from './errors.js'
import { manifestHash, parseManifest } from './manifest.js'
import { replayTask, ReplayError } from './replay.js'
import { runSessionTask } from './session-runner.js'
import { speechMetricsFromRecords } from './speech.js'
import { computePassMetrics } from './pass-k.js'
import {
  RUN_RESULT_SCHEMA_VERSION,
  buildVersions,
  parseRunResult,
  transcriptRelativePath,
  type RunResult,
} from './results.js'
import {
  createDeterministicInvariantGrader,
  type Grader,
  type SemanticGrade,
  type TrialRecord,
} from './grader.js'
import {
  createTrialEnvironment,
  settleWithin,
  snapshotEnvironment,
  withTrialTimeout,
  type ProviderFactory,
  type TrialEnvironment,
} from './trial.js'
import { computeVerdict, type RunVerdict } from './verdict.js'
import { deriveExecutionId } from '../observability/execution-id.js'
import {
  assertGraderMatchesManifest,
  assertSessionPrompt,
  createProviderFactory,
} from './run-guards.js'
import {
  computeInvariants,
  failedTrial,
  passTrials,
  score,
  summarize,
  toTrialOutcome,
} from './run-report.js'
import { loadSelectedTasks, type LoadedTask } from './task-loader.js'

export { HarnessConfigError } from './errors.js'
export { loadSelectedTasks, type LoadedTask } from './task-loader.js'

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
  const goldenEntries = await loadGoldenEntries(options.repoRoot, {
    version: manifest.tasks.version,
    languages: manifest.tasks.languages,
  })
  await assertCompositionCoversSelection({
    repoRoot: options.repoRoot,
    dataset: manifest.tasks.dataset,
    version: manifest.tasks.version,
    tasks,
    goldens: goldenEntries,
  })
  const goldens = goldenIndexByTask(goldenEntries)
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

        // A configuration error means the run cannot be trusted, not that this
        // trial measured a failure. `errors.ts` promises exactly that.
        if (error instanceof HarnessConfigError) throw error

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
