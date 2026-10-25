import type { Lang } from '../fixtures/schema.js'
import type { TraceRecord, Violation } from '@rp/session-core'
import type { RunManifest } from './manifest.js'

/**
 * Scoring port (M0 D3 seam for the Jev client).
 *
 * The runner never imports the semantic scorer: it hands the completed traces
 * and the manifest to an injected `RunScorer`. At M0 the default scorer measures
 * harness facts in ordinary code (counts, ratios, invariant outcomes), which is
 * exactly the "models judge, code decides" split: a later Jev scorer can return
 * semantic axes without changing the runner, the verdict or the artifact shape.
 */

export interface TracedRepetition {
  readonly repetition: number
  readonly fixtureId: string
  readonly lang: Lang
  /** False when the repetition failed; failed repetitions are never scored as 0. */
  readonly ok: boolean
  readonly records: readonly TraceRecord[]
  readonly jsonl?: string
  readonly traceSha256?: string
  readonly tracePath?: string
  readonly violations: readonly Violation[]
  readonly schemaValid: boolean
  readonly sequenceValid: boolean
  readonly contentClassValid: boolean
  readonly error?: string
  readonly providerOutage: boolean
}

export interface RunScorerContext {
  readonly manifest: RunManifest
  readonly repetitions: readonly TracedRepetition[]
}

/** Per-axis metric readings. There is no aggregate score. */
export interface RunScorer {
  readonly id: string
  readonly version: string
  score(context: RunScorerContext): Promise<Readonly<Record<string, number>>>
}

export const DETERMINISTIC_SCORER_ID = 'deterministic-invariants'
export const DETERMINISTIC_SCORER_VERSION = '1.0.0'

/** Higher is better: share of fixtures whose repetitions replay identically. */
export const METRIC_DETERMINISTIC_RATE = 'replay.deterministic_rate'
/** Lower is better: total §3.2 guard violations across completed traces. */
export const METRIC_GUARD_VIOLATIONS = 'trace.guard_violations'
/** Higher is better: share of completed traces that parse against the trace schema. */
export const METRIC_SCHEMA_VALID_RATE = 'trace.schema_valid_rate'
/** Higher is better: share of trace records whose content class matches the event kind. */
export const METRIC_CONTENT_CLASS_RATE = 'trace.content_class_rate'
/** Lower is better: failed repetitions divided by attempted repetitions. */
export const METRIC_FAILURE_RATE = 'run.failure_rate'

/**
 * Default M0 scorer. Every value is a count or ratio computed in code; nothing
 * here calls a model.
 */
export function createDeterministicInvariantScorer(): RunScorer {
  return {
    id: DETERMINISTIC_SCORER_ID,
    version: DETERMINISTIC_SCORER_VERSION,
    score(context) {
      return Promise.resolve(scoreInvariants(context))
    },
  }
}

function scoreInvariants(context: RunScorerContext): Record<string, number> {
  const attempts = context.repetitions.length
  const completed = context.repetitions.filter((repetition) => repetition.ok)

  const schemaValidRate =
    completed.length === 0
      ? 0
      : completed.filter((repetition) => repetition.schemaValid).length / completed.length

  const contentClassRate =
    completed.length === 0
      ? 0
      : completed.filter((repetition) => repetition.contentClassValid).length / completed.length

  const guardViolations = completed.reduce(
    (total, repetition) => total + repetition.violations.length,
    0,
  )

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
 * Fraction of (fixture, language) groups whose successful repetitions produced
 * byte-identical normalized JSONL. A group with fewer than two repetitions has
 * nothing to compare and counts as deterministic.
 */
function deterministicRate(completed: readonly TracedRepetition[]): number {
  const groups = new Map<string, string[]>()

  for (const repetition of completed) {
    if (repetition.jsonl === undefined) continue
    const key = `${repetition.lang}\u0000${repetition.fixtureId}`
    const values = groups.get(key)
    if (values === undefined) {
      groups.set(key, [repetition.jsonl])
    } else {
      values.push(repetition.jsonl)
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
