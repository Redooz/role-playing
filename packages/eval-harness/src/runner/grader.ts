import type { Lang } from '../tasks/schema.js'
import type { TranscriptRecord, Violation } from '@rp/session-core'
import type { GraderKind, RunManifest } from './manifest.js'

/**
 * Grader port (M0 D3 seam for the Jev grader).
 *
 * The evaluation harness never imports a semantic grader: it hands the
 * completed transcripts and the manifest to an injected `Grader`. At M0 the
 * default grader measures harness facts in ordinary code (counts, ratios,
 * invariant outcomes), which is exactly the "models grade, code decides" split:
 * a later Jev grader can return semantic axes without changing the harness, the
 * verdict or the artifact shape.
 */

export interface TrialRecord {
  /** The round this trial belongs to. */
  readonly round: number
  readonly taskId: string
  readonly lang: Lang
  /** False when the trial failed; failed trials are never scored as 0. */
  readonly ok: boolean
  readonly records: readonly TranscriptRecord[]
  readonly jsonl?: string
  readonly transcriptSha256?: string
  readonly transcriptPath?: string
  readonly violations: readonly Violation[]
  readonly schemaValid: boolean
  readonly sequenceValid: boolean
  readonly contentClassValid: boolean
  readonly error?: string
  readonly providerOutage: boolean
}

export interface GraderContext {
  readonly manifest: RunManifest
  readonly trials: readonly TrialRecord[]
}

/** Per-axis metric readings. There is no aggregate score. */
export interface Grader {
  readonly id: string
  readonly kind: GraderKind
  readonly version: string
  score(context: GraderContext): Promise<Readonly<Record<string, number>>>
}

export const DETERMINISTIC_GRADER_ID = 'deterministic-invariants'
export const DETERMINISTIC_GRADER_KIND = 'code'
export const DETERMINISTIC_GRADER_VERSION = '1.0.0'

/** Higher is better: share of tasks whose trials replay identically. */
export const METRIC_DETERMINISTIC_RATE = 'replay.deterministic_rate'
/** Lower is better: total §3.2 guard violations across completed transcripts. */
export const METRIC_GUARD_VIOLATIONS = 'transcript.guard_violations'
/** Higher is better: share of completed transcripts that parse against the transcript schema. */
export const METRIC_SCHEMA_VALID_RATE = 'transcript.schema_valid_rate'
/** Higher is better: share of transcript records whose content class matches the event kind. */
export const METRIC_CONTENT_CLASS_RATE = 'transcript.content_class_rate'
/** Lower is better: failed trials divided by attempted trials. */
export const METRIC_FAILURE_RATE = 'run.failure_rate'

/**
 * Default M0 grader. Every value is a count or ratio computed in code; nothing
 * here calls a model.
 */
export function createDeterministicInvariantGrader(): Grader {
  return {
    id: DETERMINISTIC_GRADER_ID,
    kind: DETERMINISTIC_GRADER_KIND,
    version: DETERMINISTIC_GRADER_VERSION,
    score(context) {
      return Promise.resolve(scoreInvariants(context))
    },
  }
}

function scoreInvariants(context: GraderContext): Record<string, number> {
  const attempts = context.trials.length
  const completed = context.trials.filter((trial) => trial.ok)

  const schemaValidRate =
    completed.length === 0
      ? 0
      : completed.filter((trial) => trial.schemaValid).length / completed.length

  const contentClassRate =
    completed.length === 0
      ? 0
      : completed.filter((trial) => trial.contentClassValid).length / completed.length

  const guardViolations = completed.reduce((total, trial) => total + trial.violations.length, 0)

  const failureRate = attempts === 0 ? 1 : (attempts - completed.length) / attempts

  return {
    [METRIC_DETERMINISTIC_RATE]: deterministicRate(completed),
    [METRIC_GUARD_VIOLATIONS]: guardViolations,
    [METRIC_SCHEMA_VALID_RATE]: schemaValidRate,
    [METRIC_CONTENT_CLASS_RATE]: contentClassRate,
    [METRIC_FAILURE_RATE]: failureRate,
  }
}

/**
 * Fraction of (task, language) groups whose successful trials produced
 * byte-identical normalized JSONL. A group with fewer than two trials has
 * nothing to compare and counts as deterministic.
 */
function deterministicRate(completed: readonly TrialRecord[]): number {
  const groups = new Map<string, string[]>()

  for (const trial of completed) {
    if (trial.jsonl === undefined) continue
    const key = `${trial.lang}\u0000${trial.taskId}`
    const values = groups.get(key)
    if (values === undefined) {
      groups.set(key, [trial.jsonl])
    } else {
      values.push(trial.jsonl)
    }
  }

  if (groups.size === 0) return 0

  let deterministic = 0
  for (const values of groups.values()) {
    const first = values[0]
    if (first === undefined) continue
    if (values.every((value) => value === first)) deterministic += 1
  }

  return deterministic / groups.size
}
