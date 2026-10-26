import { canonicalJson } from '@rp/shared'
import {
  evaluateGuardrailAxis,
  evaluateRegressionAxis,
  evaluateTargetAxis,
  type AxisVerdict,
} from './verdict.js'
import type { RunResult } from './results.js'

/**
 * Baseline vs candidate comparison (M0 D6, Architecture Plan v5 §4.1.7).
 *
 * Reports one delta per registered axis and one pass/fail/inconclusive verdict
 * per guardrail. There is no composite score: a win on the target can never hide
 * a guardrail regression.
 *
 * A comparison is only valid when the eval definition did not move (§4.1.2):
 * purpose, task selection, target, guardrails, limits, transcript checks, seeds,
 * provider, grader, grader model, rubric and transcript schema must match the
 * baseline. Otherwise the result is marked incompatible and can never pass.
 *
 * The candidate must also be a valid accepted result. A failed transcript check,
 * a failed model call, or an unconcluded run can never compare as passing.
 */

export interface ComparisonResult {
  /** True only when the definition is compatible and every axis passes. */
  readonly ok: boolean
  readonly compatible: boolean
  readonly target: AxisVerdict
  readonly guardrails: readonly AxisVerdict[]
  readonly reasons: readonly string[]
}

export function compareRunResults(baseline: RunResult, candidate: RunResult): ComparisonResult {
  const reasons: string[] = []

  const definitionChecks: readonly {
    readonly label: string
    readonly baseline: unknown
    readonly candidate: unknown
  }[] = [
    {
      label: 'eval purpose',
      baseline: baseline.manifest.run.purpose,
      candidate: candidate.manifest.run.purpose,
    },
    {
      label: 'task selection',
      baseline: baseline.manifest.tasks,
      candidate: candidate.manifest.tasks,
    },
    {
      label: 'target registration',
      baseline: baseline.manifest.target,
      candidate: candidate.manifest.target,
    },
    {
      label: 'guardrail registration',
      baseline: baseline.manifest.guardrails,
      candidate: candidate.manifest.guardrails,
    },
    {
      label: 'limit registration',
      baseline: baseline.manifest.limits,
      candidate: candidate.manifest.limits,
    },
    {
      label: 'transcript checks',
      baseline: baseline.manifest.invariants,
      candidate: candidate.manifest.invariants,
    },
    {
      label: 'seed registration',
      baseline: baseline.manifest.seeds,
      candidate: candidate.manifest.seeds,
    },
    {
      label: 'provider registration',
      baseline: baseline.manifest.provider,
      candidate: candidate.manifest.provider,
    },
  ]

  for (const check of definitionChecks) {
    if (canonicalJson(check.baseline) !== canonicalJson(check.candidate)) {
      reasons.push(
        `${check.label} differs from the baseline; changing the eval definition invalidates the comparison`,
      )
    }
  }

  const versionChecks: readonly {
    readonly label: string
    readonly key: keyof RunResult['versions']
  }[] = [
    { label: 'transcript schema version', key: 'transcriptSchemaVersion' },
    { label: 'task dataset', key: 'taskDataset' },
    { label: 'task version', key: 'taskVersion' },
    { label: 'grader id', key: 'graderId' },
    { label: 'grader kind', key: 'graderKind' },
    { label: 'grader version', key: 'graderVersion' },
    { label: 'grader model', key: 'graderModel' },
    { label: 'rubric version', key: 'rubricVersion' },
  ]

  for (const check of versionChecks) {
    const baselineValue = baseline.versions[check.key]
    const candidateValue = candidate.versions[check.key]
    if (baselineValue !== candidateValue) {
      reasons.push(
        `${check.label} changed (baseline ${String(baselineValue ?? 'none')}, candidate ${String(candidateValue ?? 'none')}); re-calibrate and re-baseline instead of comparing across versions`,
      )
    }
  }

  const compatible = reasons.length === 0

  const candidateProblems = auditCandidate(candidate)
  reasons.push(...candidateProblems)

  const target =
    candidate.manifest.run.purpose === 'regression'
      ? evaluateRegressionAxis(candidate.manifest.target, baseline.metrics, candidate.metrics)
      : evaluateTargetAxis(candidate.manifest.target, baseline.metrics, candidate.metrics)

  const guardrails = candidate.manifest.guardrails.map((guardrail) =>
    evaluateGuardrailAxis(guardrail, baseline.metrics, candidate.metrics),
  )

  if (target.status !== 'pass') reasons.push(target.reason)
  for (const guardrail of guardrails) {
    if (guardrail.status !== 'pass') reasons.push(guardrail.reason)
  }

  const ok =
    compatible &&
    candidateProblems.length === 0 &&
    target.status === 'pass' &&
    guardrails.every((guardrail) => guardrail.status === 'pass')

  return { ok, compatible, target, guardrails, reasons }
}

/**
 * A candidate is only comparable when it is itself a valid accepted result.
 * Otherwise a failed transcript check, a failed model call, or an unconcluded
 * run could still compare as passing.
 */
function auditCandidate(candidate: RunResult): string[] {
  const problems: string[] = []

  if (candidate.verdict.status !== 'accepted') {
    problems.push(
      `candidate ${candidate.runId} has verdict "${candidate.verdict.status}"; only an accepted candidate may be compared`,
    )
  }

  if (candidate.verdict.providerOutages !== 0) {
    problems.push(
      `candidate ${candidate.runId} recorded ${candidate.verdict.providerOutages} provider outage(s); a failed model call is not a pass`,
    )
  }

  const failed = candidate.invariants.filter((invariant) => !invariant.ok)
  if (failed.length > 0) {
    problems.push(
      `candidate ${candidate.runId} failed transcript check(s): ${failed.map((invariant) => invariant.id).join(', ')}`,
    )
  }

  const failedInVerdict = candidate.verdict.invariants.filter((invariant) => !invariant.ok)
  if (failedInVerdict.length > 0) {
    problems.push(
      `candidate ${candidate.runId} verdict records failed transcript check(s): ${failedInVerdict.map((invariant) => invariant.id).join(', ')}`,
    )
  }

  return problems
}
