import type { AxisVerdict, ComparisonResult, RunResult } from '@rp/eval-engine'

/** Human-readable CLI output. No composite scores and no colour codes. */

export function formatRunResult(result: RunResult): string[] {
  const lines: string[] = [
    `verdict: ${result.verdict.status}`,
    `run: ${result.runId} (${result.suite})`,
    `manifest sha256: ${result.manifestHash}`,
    `repetitions: ${result.summary.requestedRepetitions} requested, ${result.summary.attempts} attempted, ${result.summary.completed} completed, ${result.summary.failed} failed (failure rate ${formatNumber(result.summary.failureRate)})`,
    `fixture executions: ${result.summary.executions} (${result.summary.failedExecutions} failed)`,
    `traces: ${result.traces.length} normalized trace file(s)`,
    '',
    'per-axis metrics:',
    ...Object.keys(result.metrics)
      .sort()
      .map((metric) => `  ${metric} = ${formatNumber(result.metrics[metric])}`),
    '',
    formatAxis(result.verdict.target),
  ]

  for (const guardrail of result.verdict.guardrails) lines.push(formatAxis(guardrail))

  lines.push('', 'invariants:')
  for (const invariant of result.verdict.invariants) {
    lines.push(
      `  ${invariant.id}: ${invariant.ok ? 'PASS' : 'FAIL'}${
        invariant.detail === undefined ? '' : ` - ${invariant.detail}`
      }`,
    )
  }

  lines.push('', 'reasons:')
  for (const reason of result.verdict.reasons) lines.push(`  - ${reason}`)

  return lines
}

export function formatComparison(comparison: ComparisonResult): string[] {
  const lines: string[] = [
    `comparison: ${comparison.ok ? 'PASS' : 'FAIL'}${
      comparison.compatible ? '' : ' (incompatible eval definition)'
    }`,
    '',
    formatAxis(comparison.target),
  ]

  for (const guardrail of comparison.guardrails) lines.push(formatAxis(guardrail))

  lines.push('', 'reasons:')
  if (comparison.reasons.length === 0) {
    lines.push('  - no regressions and no definition drift')
  } else {
    for (const reason of comparison.reasons) lines.push(`  - ${reason}`)
  }

  return lines
}

function formatAxis(axis: AxisVerdict): string {
  const parts = [
    `${axis.kind} ${axis.metric} (${axis.direction})`,
    `baseline=${formatNumber(axis.baseline)}`,
    `value=${formatNumber(axis.value)}`,
    `delta=${formatNumber(axis.delta)}`,
    `improvement=${formatNumber(axis.improvement)}`,
    `${axis.kind === 'target' ? 'minimum detectable effect' : 'tolerance'}=${formatNumber(axis.required)}`,
    `-> ${axis.status.toUpperCase()}`,
  ]
  return `${parts.join(' ')} - ${axis.reason}`
}

export function formatNumber(value: number | undefined): string {
  if (value === undefined) return 'n/a'
  if (Number.isInteger(value)) return String(value)
  return Number(value.toFixed(6)).toString()
}
