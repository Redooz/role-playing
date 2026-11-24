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

type RateMetric = 'speak' | 'silence'

interface Requirement {
  readonly id: VerdictCheck['id']
  readonly metric: RateMetric
  readonly required: number
  /** True for the incumbent floor, which is reported only when the target passed. */
  readonly incumbent: boolean
}

function atLeast(actual: number | null, required: number): boolean {
  return actual !== null && actual >= required
}

function describe(metric: RateMetric, actual: number | null, required: number, incumbent: boolean) {
  if (actual === null) return `no completed ${metric} decision, so its rate cannot be read`
  const floor = `${incumbent ? 'the incumbent ' : ''}${required.toFixed(3)}`
  return `${metric} rate ${actual.toFixed(3)} is below ${floor}`
}

/**
 * One arm's readings against the frozen holdout targets for one language.
 *
 * The target floor is the binding adoption check. The incumbent reading is kept
 * as its own check so a future floor change cannot silently drop it, but its
 * reason is only reported when the target itself passed: one miss, one reason.
 */
export function armVerdict(arm: RoutingArmLanguageReport, targets: HoldoutTargets): ArmVerdict {
  const rates: Readonly<Record<RateMetric, number | null>> = {
    speak: arm.classes.speak.rate,
    silence: arm.classes.silence.rate,
  }
  const costPerDecision =
    arm.usage.costUsd !== null && arm.completed > 0 ? arm.usage.costUsd / arm.completed : null

  const requirements: readonly Requirement[] = [
    { id: 'speak', metric: 'speak', required: targets.speakFloor, incumbent: false },
    { id: 'silence', metric: 'silence', required: targets.silenceFloor, incumbent: false },
    {
      id: 'incumbent_speak',
      metric: 'speak',
      required: targets.incumbentSpeakRate,
      incumbent: true,
    },
    {
      id: 'incumbent_silence',
      metric: 'silence',
      required: targets.incumbentSilenceRate,
      incumbent: true,
    },
  ]
  const checks: VerdictCheck[] = [
    check('complete', arm.incomplete === 0, arm.completed, arm.n),
    ...requirements.map((requirement) =>
      check(
        requirement.id,
        atLeast(rates[requirement.metric], requirement.required),
        rates[requirement.metric],
        requirement.required,
      ),
    ),
  ]

  const floorMet: Readonly<Record<RateMetric, boolean>> = {
    speak: atLeast(rates.speak, targets.speakFloor),
    silence: atLeast(rates.silence, targets.silenceFloor),
  }
  const reasons: string[] = []
  if (arm.incomplete > 0) {
    reasons.push(
      `${arm.incomplete} infrastructure-incomplete decisions; a failed call is not a 'no'`,
    )
  }
  for (const requirement of requirements) {
    if (requirement.incumbent && !floorMet[requirement.metric]) continue
    if (atLeast(rates[requirement.metric], requirement.required)) continue
    reasons.push(
      describe(
        requirement.metric,
        rates[requirement.metric],
        requirement.required,
        requirement.incumbent,
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
    speakRate: rates.speak,
    silenceRate: rates.silence,
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

/** The frozen order: worst speak, worst silence, cost, worst p95, worst fallback. */
function compareRanking(left: ArmRanking, right: ArmRanking): number {
  if (left.worstSpeakRate !== right.worstSpeakRate) {
    return right.worstSpeakRate - left.worstSpeakRate
  }
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

/** A list of readings, or null when any one of them cannot be read. */
function readable(values: readonly (number | null)[]): readonly number[] | null {
  return values.every((value): value is number => value !== null) ? values : null
}

function rankingOf(armId: string, verdicts: readonly ArmVerdict[]): ArmRanking | null {
  const p95 = readable(verdicts.map((verdict) => verdict.p95Ms))
  const fallback = readable(verdicts.map((verdict) => verdict.fallbackRate))
  const costs = readable(verdicts.map((verdict) => verdict.costPerDecision))
  if (p95 === null || fallback === null || costs === null) return null

  const completed = verdicts.reduce((total, verdict) => total + verdict.completed, 0)
  const spend = verdicts.reduce(
    (total, verdict, index) => total + (costs[index] ?? 0) * verdict.completed,
    0,
  )
  return {
    armId,
    // `adoptable` implies both class rates are readable; `atLeast` is false for null.
    worstSpeakRate: Math.min(...verdicts.map((verdict) => verdict.speakRate as number)),
    worstSilenceRate: Math.min(...verdicts.map((verdict) => verdict.silenceRate as number)),
    costPerDecision: spend / completed,
    worstP95Ms: Math.max(...p95),
    worstFallbackRate: Math.max(...fallback),
  }
}

/** The languages the frozen rule requires before an arm can be adopted. */
const REQUIRED_LANGUAGES: readonly ArmVerdict['lang'][] = ['en', 'fr']

function coversEveryRequiredLanguage(list: readonly ArmVerdict[]): boolean {
  const seen = new Set(list.map((verdict) => verdict.lang))
  return REQUIRED_LANGUAGES.every((lang) => seen.has(lang))
}

/** Group verdicts by arm, in first-seen order. */
function groupByArm(verdicts: readonly ArmVerdict[]): Map<string, ArmVerdict[]> {
  const byArm = new Map<string, ArmVerdict[]>()
  for (const verdict of verdicts) {
    const list = byArm.get(verdict.armId)
    if (list === undefined) byArm.set(verdict.armId, [verdict])
    else list.push(verdict)
  }
  return byArm
}

/**
 * Apply the frozen selection rule across languages.
 *
 * An arm is adoptable only when it has a verdict for both languages and every
 * verdict is adoptable. A single adoptable arm is adopted without ranking. With
 * two, the worse language on each rate decides, then cost, p95 and fallback
 * rate. With no adoptable arm, nothing is adopted and no arm is a winner.
 */
export function selectHoldoutArm(verdicts: readonly ArmVerdict[]): HoldoutSelection {
  const adoptable: [string, ArmVerdict[]][] = []
  for (const [armId, list] of groupByArm(verdicts)) {
    if (!coversEveryRequiredLanguage(list)) continue
    if (list.every((verdict) => verdict.adoptable)) adoptable.push([armId, list])
  }
  const adoptableArmIds = adoptable.map(([armId]) => armId)

  if (adoptableArmIds.length === 0) {
    return {
      adoptableArmIds: [],
      adoptedArmId: null,
      ranking: [],
      reason:
        'no arm clears every floor in both languages; no arm is adopted and no arm is a winner',
    }
  }

  if (adoptable.length === 1) {
    const [armId, list] = adoptable[0]!
    const ranked = rankingOf(armId, list)
    return {
      adoptableArmIds,
      adoptedArmId: armId,
      ranking: ranked === null ? [] : [ranked],
      reason: `adopted ${armId} as the only arm that clears every floor in both languages`,
    }
  }

  const ranking = adoptable
    .flatMap(([armId, list]) => {
      const ranked = rankingOf(armId, list)
      return ranked === null ? [] : [ranked]
    })
    .sort(compareRanking)

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
