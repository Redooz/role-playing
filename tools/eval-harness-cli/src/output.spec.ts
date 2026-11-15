import { describe, expect, it } from 'vitest'
import type { AxisVerdict, ComparisonResult, RunResult } from '@rp/eval-harness'
import { formatComparison, formatNumber, formatRunResult } from './output.js'

/**
 * `formatRunResult`/`formatComparison` own the user-visible terminal contract:
 * no composite score, one line per axis, and every counter printed as measured.
 * These tests assert the exact rendered lines rather than substrings, because a
 * shifted label or a dropped counter is the defect this module can have.
 */

/** The fields `formatRunResult` reads; a stored result carries more. */
type RunResultView = {
  readonly runId: string
  readonly suite: string
  readonly manifestHash: string
  readonly verdict: RunResult['verdict']
  readonly metrics: RunResult['metrics']
  readonly summary: RunResult['summary']
  readonly transcripts: readonly unknown[]
  readonly passMetrics?: RunResult['passMetrics']
}

function runResult(view: RunResultView): RunResult {
  return view as unknown as RunResult
}

function axis(overrides: Partial<AxisVerdict> = {}): AxisVerdict {
  return {
    kind: 'target',
    metric: 'persona.semantic_match',
    direction: 'increase',
    baseline: 0.7,
    value: 0.83,
    delta: 0.13,
    improvement: 0.13,
    required: 0.05,
    status: 'pass',
    reason: 'target improved by 0.13 (required 0.05)',
    ...overrides,
  }
}

const GUARDRAIL: AxisVerdict = {
  kind: 'guardrail',
  metric: 'transcript.guard_violations',
  direction: 'decrease',
  baseline: 0,
  value: 0,
  delta: 0,
  improvement: 0,
  required: 0,
  status: 'pass',
  reason: 'guardrail held',
}

describe('formatNumber', () => {
  it('renders an unmeasured value as n/a', () => {
    expect(formatNumber(undefined)).toBe('n/a')
  })

  it('prints integers without a decimal point', () => {
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(3)).toBe('3')
    expect(formatNumber(-2)).toBe('-2')
  })

  it('rounds a fraction to six decimal places and drops trailing zeros', () => {
    expect(formatNumber(0.5)).toBe('0.5')
    expect(formatNumber(0.1234567)).toBe('0.123457')
    expect(formatNumber(0.70000001)).toBe('0.7')
    expect(formatNumber(-0.25)).toBe('-0.25')
  })

  it('collapses a value below the display precision to zero', () => {
    expect(formatNumber(0.0000001)).toBe('0')
  })
})

describe('formatRunResult', () => {
  it('renders every section of an accepted run exactly', () => {
    const result = runResult({
      runId: 'm0-canned-replay',
      suite: 'm0-canned-replay',
      manifestHash: 'f'.repeat(64),
      verdict: {
        status: 'accepted',
        target: axis(),
        guardrails: [GUARDRAIL],
        invariants: [
          { id: 'transcript.schema_valid', ok: true },
          { id: 'response.plain_text', ok: false, detail: 'persona reply 2 had markdown' },
        ],
        reasons: ['target improved by 0.13 (required 0.05)', 'guardrail held'],
        providerOutages: 0,
      },
      metrics: {
        'transcript.guard_violations': 0,
        'persona.semantic_match': 0.83,
        'response.plain_text_rate': 1,
      },
      summary: {
        requestedRounds: 2,
        attempts: 2,
        completed: 2,
        failed: 0,
        failureRate: 0,
        trials: 4,
        failedTrials: 0,
      },
      transcripts: [{}, {}, {}, {}],
      passMetrics: {
        k: 3,
        pass1: 0.75,
        passK: 0.5,
        tasks: [
          { lang: 'en', taskId: 'greeting-standup', trials: 2, successes: 2, pass1: 1, passK: 1 },
          {
            lang: 'fr',
            taskId: 'request-deadline-extension',
            trials: 2,
            successes: 1,
            pass1: 0.5,
          },
        ],
      },
    })

    expect(formatRunResult(result)).toStrictEqual([
      'verdict: accepted',
      'run: m0-canned-replay (m0-canned-replay)',
      `manifest sha256: ${'f'.repeat(64)}`,
      'rounds: 2 requested, 2 attempted, 2 completed, 0 failed (failure rate 0)',
      'trials: 4 (0 failed)',
      'transcripts: 4 normalized transcript file(s)',
      '',
      'per-axis metrics:',
      '  persona.semantic_match = 0.83',
      '  response.plain_text_rate = 1',
      '  transcript.guard_violations = 0',
      '',
      'target persona.semantic_match (increase) baseline=0.7 value=0.83 delta=0.13 improvement=0.13 minimum detectable effect=0.05 -> PASS - target improved by 0.13 (required 0.05)',
      'guardrail transcript.guard_violations (decrease) baseline=0 value=0 delta=0 improvement=0 tolerance=0 -> PASS - guardrail held',
      '',
      'invariants:',
      '  transcript.schema_valid: PASS',
      '  response.plain_text: FAIL - persona reply 2 had markdown',
      '',
      'reliability: pass^1 = 0.75, pass^3 = 0.5',
      '  en/greeting-standup: 2/2 passed (pass^1 1, pass^3 1)',
      '  fr/request-deadline-extension: 1/2 passed (pass^1 0.5)',
      '',
      'reasons:',
      '  - target improved by 0.13 (required 0.05)',
      '  - guardrail held',
    ])
  })

  it('omits the optional sections and sorts metrics for a failed run', () => {
    const result = runResult({
      runId: 'r',
      suite: 's',
      manifestHash: 'h',
      verdict: {
        status: 'inconclusive',
        target: axis({
          baseline: undefined,
          value: undefined,
          delta: undefined,
          improvement: undefined,
          status: 'inconclusive',
          reason: 'target was not measured',
        }),
        guardrails: [],
        invariants: [],
        reasons: [],
        providerOutages: 0,
      },
      metrics: { 'b.metric': 2, 'a.metric': 1 },
      summary: {
        requestedRounds: 1,
        attempts: 1,
        completed: 0,
        failed: 1,
        failureRate: 0.5,
        trials: 4,
        failedTrials: 1,
      },
      transcripts: [],
    })

    expect(formatRunResult(result)).toStrictEqual([
      'verdict: inconclusive',
      'run: r (s)',
      'manifest sha256: h',
      'rounds: 1 requested, 1 attempted, 0 completed, 1 failed (failure rate 0.5)',
      'trials: 4 (1 failed)',
      'transcripts: 0 normalized transcript file(s)',
      '',
      'per-axis metrics:',
      '  a.metric = 1',
      '  b.metric = 2',
      '',
      'target persona.semantic_match (increase) baseline=n/a value=n/a delta=n/a improvement=n/a minimum detectable effect=0.05 -> INCONCLUSIVE - target was not measured',
      '',
      'invariants:',
      '',
      'reasons:',
    ])
  })

  it('prints only pass^1 when no task has enough trials for pass^k', () => {
    const result = runResult({
      runId: 'r',
      suite: 's',
      manifestHash: 'h',
      verdict: {
        status: 'rejected',
        target: axis({ status: 'fail', reason: 'target regressed' }),
        guardrails: [],
        invariants: [{ id: 'transcript.guard_clean', ok: true, detail: 'no guard violations' }],
        reasons: ['target regressed'],
        providerOutages: 0,
      },
      metrics: { 'persona.semantic_match': 0.5 },
      summary: {
        requestedRounds: 1,
        attempts: 1,
        completed: 1,
        failed: 0,
        failureRate: 0,
        trials: 1,
        failedTrials: 0,
      },
      transcripts: [{}],
      passMetrics: {
        k: 3,
        pass1: 0,
        tasks: [{ lang: 'en', taskId: 'greeting-standup', trials: 1, successes: 0, pass1: 0 }],
      },
    })

    const lines = formatRunResult(result)

    expect(lines).toContain('  transcript.guard_clean: PASS - no guard violations')
    expect(lines).toContain('reliability: pass^1 = 0')
    expect(lines).toContain('  en/greeting-standup: 0/1 passed (pass^1 0)')
    expect(lines.some((line) => line.includes('pass^3'))).toBe(false)
  })
})

describe('formatComparison', () => {
  it('renders a compatible comparison with no regressions', () => {
    const comparison: ComparisonResult = {
      ok: true,
      compatible: true,
      target: axis(),
      guardrails: [GUARDRAIL],
      reasons: [],
    }

    expect(formatComparison(comparison)).toStrictEqual([
      'comparison: PASS',
      '',
      'target persona.semantic_match (increase) baseline=0.7 value=0.83 delta=0.13 improvement=0.13 minimum detectable effect=0.05 -> PASS - target improved by 0.13 (required 0.05)',
      'guardrail transcript.guard_violations (decrease) baseline=0 value=0 delta=0 improvement=0 tolerance=0 -> PASS - guardrail held',
      '',
      'reasons:',
      '  - no regressions and no definition drift',
    ])
  })

  it('marks an incompatible definition and lists every reason', () => {
    const comparison: ComparisonResult = {
      ok: false,
      compatible: false,
      target: axis({ status: 'inconclusive', reason: 'target was not measured' }),
      guardrails: [],
      reasons: ['eval definition changed: target registration', 'candidate run is not accepted'],
    }

    expect(formatComparison(comparison)).toStrictEqual([
      'comparison: FAIL (incompatible eval definition)',
      '',
      'target persona.semantic_match (increase) baseline=0.7 value=0.83 delta=0.13 improvement=0.13 minimum detectable effect=0.05 -> INCONCLUSIVE - target was not measured',
      '',
      'reasons:',
      '  - eval definition changed: target registration',
      '  - candidate run is not accepted',
    ])
  })
})
