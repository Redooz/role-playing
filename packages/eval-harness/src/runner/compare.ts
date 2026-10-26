import { canonicalJson } from '@rp/shared'
import { evaluateGuardrailAxis, evaluateTargetAxis, type AxisVerdict } from './verdict.js'
import type { RunResult } from './results.js'

/**
 * Baseline vs candidate comparison (M0 D6, Architecture Plan v5 §4.1.7).
 *
 * Reports one delta per registered axis and one pass/fail/inconclusive verdict
 * per guardrail. There is no composite score: a win on the target can never hide
 * a guardrail regression.
 *
 * A comparison is only valid when the eval definition did not move (§4.1.2):
 * task selection, target registration, guardrail registrations, grader,
 * grader model, rubric and transcript schema must match the baseline. Otherwise the
 * result is marked incompatible and can never pass.
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

  const target = evaluateTargetAxis(candidate.manifest.target, baseline.metrics, candidate.metrics)

  const guardrails = candidate.manifest.guardrails.map((guardrail) =>
    evaluateGuardrailAxis(guardrail, baseline.metrics, candidate.metrics),
  )

  if (target.status !== 'pass') reasons.push(target.reason)
  for (const guardrail of guardrails) {
    if (guardrail.status !== 'pass') reasons.push(guardrail.reason)
  }

  const ok =
    compatible &&
    target.status === 'pass' &&
    guardrails.every((guardrail) => guardrail.status === 'pass')

  return { ok, compatible, target, guardrails, reasons }
}
