import { z } from 'zod'
import {
  invariantResultSchema,
  metricDirectionSchema,
  metricNameSchema,
  type EvalPurpose,
  type GuardrailRegistration,
  type InvariantResult,
  type RunManifest,
  type TargetRegistration,
} from './manifest.js'

/**
 * Verdict computation (M0 D3, Architecture Plan v5 §4.1/§4.5).
 *
 * This function is pure: it reads the pre-registered manifest and the measured
 * axis values, and nothing from the feature under test. Rules:
 *
 * - target improved by at least the registered minimum detectable effect, every
 *   guardrail non-regressed and every invariant holding → `accepted`;
 * - a hard invariant fails, a guardrail regresses, or the target regresses →
 *   `rejected`;
 * - the registered round or failure limit is exceeded, the target improves
 *   by less than the minimum detectable effect, or an axis was not measured →
 *   `inconclusive`;
 * - a provider/API call failed → `infrastructure_inconclusive`. A failed call is
 *   never converted to "no", zero, or a pass (§4.3).
 *
 * There is deliberately no composite score: every axis carries its own status
 * and reason (§4.1.7).
 */

const EPSILON = 1e-12

export const VERDICT_STATUSES = [
  'accepted',
  'rejected',
  'inconclusive',
  'infrastructure_inconclusive',
] as const

export const verdictStatusSchema = z.enum(VERDICT_STATUSES)

export type VerdictStatus = z.infer<typeof verdictStatusSchema>

export const axisKindSchema = z.enum(['target', 'guardrail'])
export type AxisKind = z.infer<typeof axisKindSchema>

export const axisStatusSchema = z.enum(['pass', 'fail', 'inconclusive'])
export type AxisStatus = z.infer<typeof axisStatusSchema>

export const axisVerdictSchema = z.strictObject({
  kind: axisKindSchema,
  metric: metricNameSchema,
  direction: metricDirectionSchema,
  baseline: z.number().finite().optional(),
  value: z.number().finite().optional(),
  /** Candidate minus baseline. Reported as measured, never direction-adjusted. */
  delta: z.number().finite().optional(),
  /** Direction-adjusted change: positive always means "better". */
  improvement: z.number().finite().optional(),
  /** Minimum detectable effect (target) or tolerance (guardrail). */
  required: z.number().finite(),
  status: axisStatusSchema,
  reason: z.string().min(1),
})

export type AxisVerdict = z.infer<typeof axisVerdictSchema>

export const runVerdictSchema = z.strictObject({
  status: verdictStatusSchema,
  target: axisVerdictSchema,
  guardrails: z.array(axisVerdictSchema),
  invariants: z.array(invariantResultSchema),
  reasons: z.array(z.string().min(1)),
  providerOutages: z.int().nonnegative(),
})

export type RunVerdict = z.infer<typeof runVerdictSchema>

export interface RoundCounts {
  /** Rounds pre-registered in the manifest. */
  readonly requested: number
  /** Rounds actually attempted. */
  readonly attempts: number
  /** Rounds that produced a valid, scorable transcript for every task. */
  readonly completed: number
}

export interface VerdictInput {
  readonly manifest: RunManifest
  /** Measured value per axis. Missing axes are inconclusive, never zero. */
  readonly metrics: Readonly<Record<string, number>>
  readonly rounds: RoundCounts
  readonly invariants: readonly InvariantResult[]
  /** Failed provider/API calls. Any outage makes the result infrastructure-inconclusive. */
  readonly providerOutages: number
  /** Optional override of the pre-registered baseline readings. */
  readonly baselineMetrics?: Readonly<Record<string, number>>
}

/** Compute a verdict from the manifest and measured values. Pure. */
export function computeVerdict(input: VerdictInput): RunVerdict {
  const baselineMetrics = input.baselineMetrics ?? input.manifest.baseline?.metrics ?? {}
  const requestedInvariants = new Set(input.manifest.invariants)

  const invariants = input.manifest.invariants.map((id) => {
    const measured = input.invariants.find((result) => result.id === id)
    if (measured === undefined) {
      return { id, ok: false, detail: 'invariant was registered but not measured' }
    }
    return measured
  })

  const target =
    input.manifest.run.purpose === 'regression'
      ? evaluateRegressionAxis(input.manifest.target, baselineMetrics, input.metrics)
      : evaluateTargetAxis(input.manifest.target, baselineMetrics, input.metrics)
  const guardrails = input.manifest.guardrails.map((guardrail) =>
    evaluateGuardrailAxis(guardrail, baselineMetrics, input.metrics),
  )

  const reasons: string[] = []
  const failed = input.rounds.attempts - input.rounds.completed
  const failureRate = input.rounds.attempts === 0 ? 1 : failed / input.rounds.attempts

  if (input.providerOutages > 0) {
    reasons.push(
      `${input.providerOutages} provider call(s) failed; provider outages are infrastructure-inconclusive and are never scored as "no" or zero`,
    )
  }

  if (input.rounds.attempts > input.rounds.requested) {
    reasons.push(
      `attempted ${input.rounds.attempts} rounds, exceeding the pre-registered limit of ${input.rounds.requested}`,
    )
  }

  if (failureRate > input.manifest.limits.maxFailureRate + EPSILON) {
    reasons.push(
      `failure rate ${formatNumber(failureRate)} exceeds the registered limit ${formatNumber(input.manifest.limits.maxFailureRate)}`,
    )
  }

  if (input.rounds.completed === 0) {
    reasons.push('no round completed successfully, so there is nothing to score')
  }

  const failedInvariants = invariants.filter((invariant) => !invariant.ok)
  if (failedInvariants.length > 0) {
    reasons.push(
      `invariant(s) failed: ${failedInvariants.map((invariant) => invariant.id).join(', ')}`,
    )
  }

  const failedGuardrails = guardrails.filter((guardrail) => guardrail.status === 'fail')
  for (const guardrail of failedGuardrails) reasons.push(guardrail.reason)

  if (target.status !== 'pass') reasons.push(target.reason)

  const inconclusiveGuardrails = guardrails.filter(
    (guardrail) => guardrail.status === 'inconclusive',
  )
  for (const guardrail of inconclusiveGuardrails) reasons.push(guardrail.reason)

  const status = decideStatus({
    input,
    invariants,
    target,
    guardrails,
    failureRate,
  })

  const statusReason = describeStatus(
    status,
    input.manifest.run.purpose,
    target,
    guardrails,
    failedInvariants,
  )
  if (statusReason !== undefined) reasons.push(statusReason)

  // Keep only registered invariant ids, even if a caller passed extras.
  const registeredInvariants = invariants.filter((invariant) =>
    requestedInvariants.has(invariant.id),
  )

  return {
    status,
    target,
    guardrails,
    invariants: registeredInvariants,
    reasons,
    providerOutages: input.providerOutages,
  }
}

interface DecideStatusInput {
  readonly input: VerdictInput
  readonly invariants: readonly InvariantResult[]
  readonly target: AxisVerdict
  readonly guardrails: readonly AxisVerdict[]
  readonly failureRate: number
}

function decideStatus(args: DecideStatusInput): VerdictStatus {
  const { input, invariants, target, guardrails, failureRate } = args

  if (input.providerOutages > 0) return 'infrastructure_inconclusive'

  if (
    input.rounds.attempts > input.rounds.requested ||
    failureRate > input.manifest.limits.maxFailureRate + EPSILON ||
    input.rounds.completed === 0
  ) {
    return 'inconclusive'
  }

  if (invariants.some((invariant) => !invariant.ok)) return 'rejected'
  if (guardrails.some((guardrail) => guardrail.status === 'fail')) return 'rejected'
  if (target.status === 'fail') return 'rejected'
  if (target.status === 'inconclusive') return 'inconclusive'
  if (guardrails.some((guardrail) => guardrail.status === 'inconclusive')) return 'inconclusive'

  return 'accepted'
}

function describeStatus(
  status: VerdictStatus,
  purpose: EvalPurpose,
  target: AxisVerdict,
  guardrails: readonly AxisVerdict[],
  failedInvariants: readonly InvariantResult[],
): string | undefined {
  switch (status) {
    case 'accepted':
      return purpose === 'regression'
        ? `regression axis "${target.metric}" held (delta ${formatNumber(target.delta ?? 0)}), ${guardrails.length} guardrail(s) held and all invariants passed`
        : `target "${target.metric}" improved by ${formatNumber(target.improvement ?? 0)} (required ${formatNumber(target.required)}), ${guardrails.length} guardrail(s) held and all invariants passed`
    case 'rejected':
      if (failedInvariants.length > 0) return undefined
      if (guardrails.some((guardrail) => guardrail.status === 'fail')) return undefined
      if (target.status === 'fail') return undefined
      return 'a registered gate failed'
    case 'inconclusive':
      return 'the run is inconclusive; it is not an acceptance'
    case 'infrastructure_inconclusive':
      return 'the run is infrastructure-inconclusive; re-run when providers are healthy'
  }
}

/** Evaluate the registered target axis against baseline readings. */
export function evaluateTargetAxis(
  target: TargetRegistration,
  baselineMetrics: Readonly<Record<string, number>>,
  metrics: Readonly<Record<string, number>>,
): AxisVerdict {
  const baseline = baselineMetrics[target.metric]
  const value = metrics[target.metric]

  if (value === undefined) {
    return {
      kind: 'target',
      metric: target.metric,
      direction: target.direction,
      baseline,
      required: target.minimumDetectableEffect,
      status: 'inconclusive',
      reason: `target metric "${target.metric}" was not measured`,
    }
  }

  if (baseline === undefined) {
    return {
      kind: 'target',
      metric: target.metric,
      direction: target.direction,
      value,
      required: target.minimumDetectableEffect,
      status: 'inconclusive',
      reason: `target metric "${target.metric}" has no pre-registered baseline reading`,
    }
  }

  const delta = value - baseline
  const improvement = target.direction === 'increase' ? delta : -delta

  if (improvement < -EPSILON) {
    return {
      kind: 'target',
      metric: target.metric,
      direction: target.direction,
      baseline,
      value,
      delta,
      improvement,
      required: target.minimumDetectableEffect,
      status: 'fail',
      reason: `target metric "${target.metric}" regressed by ${formatNumber(-improvement)}`,
    }
  }

  if (improvement + EPSILON < target.minimumDetectableEffect) {
    return {
      kind: 'target',
      metric: target.metric,
      direction: target.direction,
      baseline,
      value,
      delta,
      improvement,
      required: target.minimumDetectableEffect,
      status: 'inconclusive',
      reason: `target metric "${target.metric}" improved by ${formatNumber(improvement)}, below the registered minimum detectable effect ${formatNumber(target.minimumDetectableEffect)}`,
    }
  }

  return {
    kind: 'target',
    metric: target.metric,
    direction: target.direction,
    baseline,
    value,
    delta,
    improvement,
    required: target.minimumDetectableEffect,
    status: 'pass',
    reason: `target metric "${target.metric}" improved by ${formatNumber(improvement)} (required ${formatNumber(target.minimumDetectableEffect)})`,
  }
}

/** Evaluate the primary axis of a regression eval; it must hold, not improve. */
export function evaluateRegressionAxis(
  target: TargetRegistration,
  baselineMetrics: Readonly<Record<string, number>>,
  metrics: Readonly<Record<string, number>>,
): AxisVerdict {
  const baseline = baselineMetrics[target.metric]
  const value = metrics[target.metric]

  if (value === undefined) {
    return {
      kind: 'target',
      metric: target.metric,
      direction: target.direction,
      baseline,
      required: 0,
      status: 'inconclusive',
      reason: `regression axis "${target.metric}" was not measured`,
    }
  }

  if (baseline === undefined) {
    return {
      kind: 'target',
      metric: target.metric,
      direction: target.direction,
      value,
      required: 0,
      status: 'inconclusive',
      reason: `regression axis "${target.metric}" has no pre-registered baseline reading`,
    }
  }

  const delta = value - baseline
  const improvement = target.direction === 'increase' ? delta : -delta

  if (improvement < -EPSILON) {
    return {
      kind: 'target',
      metric: target.metric,
      direction: target.direction,
      baseline,
      value,
      delta,
      improvement,
      required: 0,
      status: 'fail',
      reason: `regression axis "${target.metric}" regressed by ${formatNumber(-improvement)}`,
    }
  }

  return {
    kind: 'target',
    metric: target.metric,
    direction: target.direction,
    baseline,
    value,
    delta,
    improvement,
    required: 0,
    status: 'pass',
    reason:
      improvement > EPSILON
        ? `regression axis "${target.metric}" held and improved by ${formatNumber(improvement)}`
        : `regression axis "${target.metric}" held`,
  }
}

/** Evaluate one registered guardrail; any regression beyond its tolerance fails. */
export function evaluateGuardrailAxis(
  guardrail: GuardrailRegistration,
  baselineMetrics: Readonly<Record<string, number>>,
  metrics: Readonly<Record<string, number>>,
): AxisVerdict {
  const baseline = baselineMetrics[guardrail.metric]
  const value = metrics[guardrail.metric]

  if (value === undefined) {
    return {
      kind: 'guardrail',
      metric: guardrail.metric,
      direction: guardrail.direction,
      baseline,
      required: guardrail.tolerance,
      status: 'inconclusive',
      reason: `guardrail "${guardrail.metric}" was not measured`,
    }
  }

  if (baseline === undefined) {
    return {
      kind: 'guardrail',
      metric: guardrail.metric,
      direction: guardrail.direction,
      value,
      required: guardrail.tolerance,
      status: 'inconclusive',
      reason: `guardrail "${guardrail.metric}" has no pre-registered baseline reading`,
    }
  }

  const delta = value - baseline
  const improvement = guardrail.direction === 'increase' ? delta : -delta
  const regression = -improvement

  if (regression > guardrail.tolerance + EPSILON) {
    return {
      kind: 'guardrail',
      metric: guardrail.metric,
      direction: guardrail.direction,
      baseline,
      value,
      delta,
      improvement,
      required: guardrail.tolerance,
      status: 'fail',
      reason: `guardrail "${guardrail.metric}" regressed by ${formatNumber(regression)}, beyond the tolerated ${formatNumber(guardrail.tolerance)}`,
    }
  }

  return {
    kind: 'guardrail',
    metric: guardrail.metric,
    direction: guardrail.direction,
    baseline,
    value,
    delta,
    improvement,
    required: guardrail.tolerance,
    status: 'pass',
    reason:
      regression > 0
        ? `guardrail "${guardrail.metric}" regressed by ${formatNumber(regression)}, within the tolerated ${formatNumber(guardrail.tolerance)}`
        : `guardrail "${guardrail.metric}" held`,
  }
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return Number(value.toFixed(6)).toString()
}
