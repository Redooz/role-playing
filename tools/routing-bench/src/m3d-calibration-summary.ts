import { routingDecisionSchema } from '@rp/routing-policy'
import type {
  RoutingArmLanguageReport,
  RoutingMatrixEntry,
  RoutingMatrixReport,
} from '@rp/eval-harness'
import type { FamilyReading } from '@rp/eval-harness'

/**
 * Summary assembly for the M3d D3 calibration comparison.
 *
 * Kept pure and outside the script: the numbers a reader sees are built from
 * the same records the artifacts hold, and a missing reference reading is an
 * error rather than a zero.
 */

export interface ReferenceReadings {
  readonly runId: string
  readonly requiredSpeakerRate: number
  readonly silenceAppropriateRate: number
  readonly acceptableSpeakerRate: number
}

export interface DeclineTally {
  readonly armId: string
  readonly lang: 'en' | 'fr'
  readonly reason: string
  readonly count: number
}

export interface CalibrationInvariant {
  readonly id: string
  readonly ok: boolean
  readonly detail?: string
}

/**
 * A summary is a finished run only when every context and every decision is
 * complete. An incomplete run must not exit as a success.
 */
export function calibrationExitCode(summary: CalibrationSummary): 0 | 1 {
  return summary.invariants.every((invariant) => invariant.ok) ? 0 : 1
}

export interface CalibrationSummary {
  readonly schemaVersion: '1.0.0'
  readonly suite: 'm3d-routing-calibration'
  readonly lang: 'en' | 'fr'
  readonly tasks: number
  readonly contexts: number
  readonly expectedContexts: number
  readonly reference: ReferenceReadings
  readonly arms: readonly RoutingArmLanguageReport[]
  readonly families: readonly FamilyReading[]
  readonly declineReasons: readonly DeclineTally[]
  readonly invariants: readonly CalibrationInvariant[]
  readonly note: string
}

const METRIC_KEYS = {
  requiredSpeakerRate: 'turn_taking.required_speaker_rate',
  silenceAppropriateRate: 'turn_taking.silence_appropriate_rate',
  acceptableSpeakerRate: 'turn_taking.acceptable_speaker_rate',
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function metricOf(metrics: unknown, key: string): number {
  if (!isRecord(metrics)) throw new Error('the reference run has no metrics record')
  const value = metrics[key]
  // `Number.isFinite` rejects every non-number, so no separate type guard is
  // needed; the cast is safe behind the guard.
  if (!Number.isFinite(value)) throw new Error(`the reference run has no finite "${key}" reading`)
  return value as number
}

/** Read the fixed-rotation reference readings from a finished run's metrics. */
export function referenceReadings(runId: string, metrics: unknown): ReferenceReadings {
  return {
    runId,
    requiredSpeakerRate: metricOf(metrics, METRIC_KEYS.requiredSpeakerRate),
    silenceAppropriateRate: metricOf(metrics, METRIC_KEYS.silenceAppropriateRate),
    acceptableSpeakerRate: metricOf(metrics, METRIC_KEYS.acceptableSpeakerRate),
  }
}

/** Count every decline reason per arm and language, in a stable order. */
export function declineTallies(entries: readonly RoutingMatrixEntry[]): readonly DeclineTally[] {
  const counts = new Map<string, DeclineTally>()
  for (const entry of entries) {
    // A failed call has no decision; it is counted by the matrix, never parsed.
    if (entry.artifact.outcome !== 'completed' || entry.artifact.decision === undefined) continue
    const decision = routingDecisionSchema.parse(entry.artifact.decision)
    for (const decline of decision.declines) {
      const key = `${entry.armId}\u0000${entry.lang}\u0000${decline.reason}`
      const current = counts.get(key)
      counts.set(key, {
        armId: entry.armId,
        lang: entry.lang,
        reason: decline.reason,
        count: (current?.count ?? 0) + 1,
      })
    }
  }
  return [...counts.values()].sort(
    (left, right) =>
      left.armId.localeCompare(right.armId) ||
      left.lang.localeCompare(right.lang) ||
      left.reason.localeCompare(right.reason),
  )
}

export interface CalibrationSummaryInput {
  readonly lang: 'en' | 'fr'
  readonly reference: ReferenceReadings
  readonly matrix: RoutingMatrixReport
  readonly families: readonly FamilyReading[]
  readonly entries: readonly RoutingMatrixEntry[]
  readonly tasks: number
  readonly contexts: number
  readonly expectedContexts: number
}

const NOTE =
  'Calibration only. Diagnostic comparison of the Jev topology arms against the fixed-rotation reference; no policy is adopted and no holdout context is read.'

/** Assemble the summary and its invariants. Never folds axes into one score. */
export function calibrationSummary(input: CalibrationSummaryInput): CalibrationSummary {
  const incomplete = input.matrix.arms.reduce((total, arm) => total + arm.incomplete, 0)
  const invariants: CalibrationInvariant[] = [
    {
      id: 'routing.contexts_complete',
      ok: input.contexts === input.expectedContexts,
      detail: `${input.contexts} contexts built against ${input.expectedContexts} expected`,
    },
    {
      id: 'routing.decisions_complete',
      ok: incomplete === 0,
      detail: `${incomplete} infrastructure-incomplete decisions`,
    },
  ]

  return {
    schemaVersion: '1.0.0',
    suite: 'm3d-routing-calibration',
    lang: input.lang,
    tasks: input.tasks,
    contexts: input.contexts,
    expectedContexts: input.expectedContexts,
    reference: input.reference,
    arms: input.matrix.arms,
    families: input.families,
    declineReasons: declineTallies(input.entries),
    invariants,
    note: NOTE,
  }
}
