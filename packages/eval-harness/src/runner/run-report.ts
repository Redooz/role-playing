import type { Violation } from '@rp/session-core'
import { errorMessage, HarnessConfigError } from './errors.js'
import type { Grader, SemanticGrade, TrialRecord } from './grader.js'
import type { InvariantResult, RunManifest } from './manifest.js'
import {
  metricReadingsSchema,
  type MetricReadings,
  type RunSummary,
  type TrialOutcome,
} from './results.js'
import { ProviderUnavailableError } from './canned-provider.js'
import { TrialTimeoutError } from './trial.js'
import type { TaskEntry } from '../tasks/schema.js'

/**
 * Result assembly for the evaluation harness.
 *
 * Turns raw trial records into the artifact's per-axis metric readings,
 * invariants, round summary and pass^k outcomes. It never infers a verdict:
 * `computeVerdict` stays the only decision point, and a failed trial is never
 * turned into a zero.
 */

export async function score(
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

export function computeInvariants(
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

export function summarize(
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
export function passTrials(
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

export function failedTrial(round: number, task: TaskEntry, error: unknown): TrialRecord {
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

export function toTrialOutcome(trial: TrialRecord): TrialOutcome {
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
