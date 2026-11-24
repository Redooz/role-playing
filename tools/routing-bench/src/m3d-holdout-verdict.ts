import type { RoutingArmLanguageReport } from '@rp/eval-harness'

/**
 * Pre-registered holdout verdicts for the M3d routing comparison (D4).
 *
 * The target readings, floors and selection order are frozen in
 * `docs/plans/m3d-plan-routing-contract.md` and in the D4 row of
 * `evals/decisions.md` before the run. Nothing here is computed from the run it
 * judges: the floors come from the pre-registered minimum detectable effect over
 * the fixed-rotation baseline, and the incumbent readings from the recorded
 * `m3b-v2-det-persona-*-r3` runs.
 *
 * The offline comparison measures routing decisions against the same golden
 * speaker labels the session runs score, so the session metric names map onto
 * the class readings: `required_speaker_rate` is the completed `speak` class
 * rate, `silence_appropriate_rate` the completed `silence` class rate.
 */

export interface HoldoutTargets {
  /** Pre-registered speak floor for this language. */
  readonly speakFloor: number
  /** Absolute silence floor, the same in both languages. */
  readonly silenceFloor: number
  /** Recorded `det-persona` speak rate on the same holdout tasks. */
  readonly incumbentSpeakRate: number
  /** Recorded `det-persona` silence rate on the same holdout tasks. */
  readonly incumbentSilenceRate: number
}

export const HOLDOUT_TARGETS: Readonly<Record<'en' | 'fr', HoldoutTargets>> = {
  en: {
    speakFloor: 0.826,
    silenceFloor: 0.75,
    incumbentSpeakRate: 13 / 17,
    incumbentSilenceRate: 8 / 12,
  },
  fr: {
    speakFloor: 0.768,
    silenceFloor: 0.75,
    incumbentSpeakRate: 11 / 17,
    incumbentSilenceRate: 8 / 12,
  },
}

export interface VerdictCheck {
  readonly id: 'complete' | 'speak' | 'silence' | 'incumbent_speak' | 'incumbent_silence'
  readonly ok: boolean
  readonly actual: number | null
  readonly required: number | null
}

export interface ArmVerdict {
  readonly armId: string
  readonly lang: 'en' | 'fr'
  readonly n: number
  readonly completed: number
  readonly incomplete: number
  readonly timeouts: number
  readonly speakRate: number | null
  readonly silenceRate: number | null
  readonly costPerDecision: number | null
  readonly p95Ms: number | null
  readonly fallbackRate: number | null
  readonly checks: readonly VerdictCheck[]
  /** Every check passed. An incomplete run is never adoptable. */
  readonly adoptable: boolean
  readonly reasons: readonly string[]
}

function check(
  id: VerdictCheck['id'],
  ok: boolean,
  actual: number | null,
  required: number | null,
): VerdictCheck {
  return { id, ok, actual, required }
}

function speakReason(actual: number | null, required: number): string {
  return actual === null
    ? 'no completed speak decision, so the speak rate cannot be read'
    : `speak rate ${actual.toFixed(3)} is below ${required.toFixed(3)}`
}

function silenceReason(actual: number | null, required: number): string {
  return actual === null
    ? 'no completed silence decision, so the silence rate cannot be read'
    : `silence rate ${actual.toFixed(3)} is below ${required.toFixed(3)}`
}

/** One arm's readings against the frozen holdout targets for one language. */
export function armVerdict(arm: RoutingArmLanguageReport, targets: HoldoutTargets): ArmVerdict {
  const speakRate = arm.classes.speak.rate
  const silenceRate = arm.classes.silence.rate
  const costPerDecision =
    arm.usage.costUsd === null || arm.completed === 0 ? null : arm.usage.costUsd / arm.completed

  const checks: VerdictCheck[] = [
    check('complete', arm.incomplete === 0, arm.completed, arm.n),
    check(
      'speak',
      speakRate !== null && speakRate >= targets.speakFloor,
      speakRate,
      targets.speakFloor,
    ),
    check(
      'silence',
      silenceRate !== null && silenceRate >= targets.silenceFloor,
      silenceRate,
      targets.silenceFloor,
    ),
    check(
      'incumbent_speak',
      speakRate !== null && speakRate >= targets.incumbentSpeakRate,
      speakRate,
      targets.incumbentSpeakRate,
    ),
    check(
      'incumbent_silence',
      silenceRate !== null && silenceRate >= targets.incumbentSilenceRate,
      silenceRate,
      targets.incumbentSilenceRate,
    ),
  ]

  const reasons: string[] = []
  if (arm.incomplete > 0) {
    reasons.push(
      `${arm.incomplete} infrastructure-incomplete decisions; a failed call is not a 'no'`,
    )
  }
  if (!checks[1]!.ok) reasons.push(speakReason(speakRate, targets.speakFloor))
  if (!checks[2]!.ok) reasons.push(silenceReason(silenceRate, targets.silenceFloor))
  if (checks[3]!.ok === false && checks[1]!.ok) {
    reasons.push(
      speakReason(speakRate, targets.incumbentSpeakRate).replace('below', 'below the incumbent'),
    )
  }
  if (checks[4]!.ok === false && checks[2]!.ok) {
    reasons.push(
      silenceReason(silenceRate, targets.incumbentSilenceRate).replace(
        'below',
        'below the incumbent',
      ),
    )
  }

  return {
    armId: arm.armId,
    lang: arm.lang,
    n: arm.n,
    completed: arm.completed,
    incomplete: arm.incomplete,
    timeouts: arm.timeouts,
    speakRate,
    silenceRate,
    costPerDecision,
    p95Ms: arm.latencyMs?.p95 ?? null,
    fallbackRate: arm.fallbackRate,
    checks,
    adoptable: checks.every((entry) => entry.ok),
    reasons,
  }
}

export interface ArmRanking {
  readonly armId: string
  /** Worst speak rate across languages: higher is better. */
  readonly worstSpeakRate: number
  /** Worst silence rate across languages: higher is better. */
  readonly worstSilenceRate: number
  /** Total cost over total completed decisions: lower is better. */
  readonly costPerDecision: number
  /** Worst p95 across languages: lower is better. */
  readonly worstP95Ms: number
  /** Worst fallback rate across languages: lower is better. */
  readonly worstFallbackRate: number
}

export interface HoldoutSelection {
  readonly adoptableArmIds: readonly string[]
  readonly adoptedArmId: string | null
  readonly ranking: readonly ArmRanking[]
  readonly reason: string
}

function compareRanking(left: ArmRanking, right: ArmRanking): number {
  if (left.worstSpeakRate !== right.worstSpeakRate)
    return right.worstSpeakRate - left.worstSpeakRate
  if (left.worstSilenceRate !== right.worstSilenceRate) {
    return right.worstSilenceRate - left.worstSilenceRate
  }
  if (left.costPerDecision !== right.costPerDecision) {
    return left.costPerDecision - right.costPerDecision
  }
  if (left.worstP95Ms !== right.worstP95Ms) return left.worstP95Ms - right.worstP95Ms
  if (left.worstFallbackRate !== right.worstFallbackRate) {
    return left.worstFallbackRate - right.worstFallbackRate
  }
  return left.armId.localeCompare(right.armId)
}

function rankingOf(armId: string, verdicts: readonly ArmVerdict[]): ArmRanking | null {
  const completed = verdicts.reduce((total, verdict) => total + verdict.completed, 0)
  const cost = verdicts.every((verdict) => verdict.costPerDecision !== null)
    ? verdicts.reduce(
        (total, verdict) => total + (verdict.costPerDecision ?? 0) * verdict.completed,
        0,
      )
    : null
  const rates = verdicts.flatMap((verdict) =>
    verdict.speakRate === null || verdict.silenceRate === null || verdict.p95Ms === null
      ? []
      : [{ speak: verdict.speakRate, silence: verdict.silenceRate, p95: verdict.p95Ms }],
  )
  const fallbacks = verdicts.flatMap((verdict) =>
    verdict.fallbackRate === null ? [] : [verdict.fallbackRate],
  )
  if (
    cost === null ||
    completed === 0 ||
    rates.length !== verdicts.length ||
    fallbacks.length !== verdicts.length
  ) {
    return null
  }
  return {
    armId,
    worstSpeakRate: Math.min(...rates.map((rate) => rate.speak)),
    worstSilenceRate: Math.min(...rates.map((rate) => rate.silence)),
    costPerDecision: cost / completed,
    worstP95Ms: Math.max(...rates.map((rate) => rate.p95)),
    worstFallbackRate: Math.max(...fallbacks),
  }
}

/**
 * Apply the frozen selection rule across languages.
 *
 * An arm is adoptable only when every language's verdict is adoptable. Adoptable
 * arms rank by the worse language on each rate, then by cost, p95 and fallback
 * rate. With no adoptable arm, nothing is adopted and no arm is called a winner.
 */
export function selectHoldoutArm(verdicts: readonly ArmVerdict[]): HoldoutSelection {
  const armIds = [...new Set(verdicts.map((verdict) => verdict.armId))]
  const adoptableArmIds = armIds
    .filter((armId) => verdicts.filter((v) => v.armId === armId).every((v) => v.adoptable))
    .sort()
  const ranking = adoptableArmIds
    .flatMap((armId) => {
      const ranked = rankingOf(
        armId,
        verdicts.filter((verdict) => verdict.armId === armId),
      )
      return ranked === null ? [] : [ranked]
    })
    .sort(compareRanking)

  if (adoptableArmIds.length === 0) {
    return {
      adoptableArmIds: [],
      adoptedArmId: null,
      ranking: [],
      reason:
        'no arm clears every floor in both languages; no arm is adopted and no arm is a winner',
    }
  }
  if (ranking.length !== adoptableArmIds.length) {
    return {
      adoptableArmIds,
      adoptedArmId: null,
      ranking,
      reason: 'an adoptable arm has no readable ranking key; no arm is adopted',
    }
  }
  const adopted = ranking[0]!
  return {
    adoptableArmIds,
    adoptedArmId: adopted.armId,
    ranking,
    reason: `adopted ${adopted.armId} by the pre-registered order: worst speak rate, worst silence rate, cost per decision, worst p95, worst fallback rate`,
  }
}
