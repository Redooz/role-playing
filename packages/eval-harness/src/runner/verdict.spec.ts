import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  VERDICT_STATUSES,
  axisKindSchema,
  axisStatusSchema,
  axisVerdictSchema,
  computeVerdict,
  evaluateGuardrailAxis,
  evaluateRegressionAxis,
  evaluateTargetAxis,
  runVerdictSchema,
  verdictStatusSchema,
  type AxisVerdict,
  type RoundCounts,
  type RunVerdict,
  type VerdictInput,
} from './verdict.js'
import {
  parseManifest,
  type GuardrailRegistration,
  type InvariantResult,
  type RunManifest,
  type TargetRegistration,
} from './manifest.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const examplePath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')

function loadRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(examplePath, 'utf8')) as Record<string, unknown>
}

const manifest = parseManifest(loadRaw())
const baselineMetrics = manifest.baseline?.metrics ?? {}
const goodMetrics: Readonly<Record<string, number>> = { ...baselineMetrics }

const passingInvariants: InvariantResult[] = manifest.invariants.map((id) => ({
  id,
  ok: true,
  detail: 'test task',
}))

const goodCounts: RoundCounts = { requested: 2, attempts: 2, completed: 2 }

function evaluate(overrides: Partial<VerdictInput> = {}): ReturnType<typeof computeVerdict> {
  return computeVerdict({
    manifest,
    metrics: goodMetrics,
    rounds: goodCounts,
    invariants: passingInvariants,
    providerOutages: 0,
    ...overrides,
  })
}

function withTarget(
  minimumDetectableEffect: number,
  metrics: Readonly<Record<string, number>>,
): ReturnType<typeof computeVerdict> {
  const raw = loadRaw()
  ;(raw['run'] as Record<string, unknown>)['purpose'] = 'capability'
  raw['target'] = {
    ...(raw['target'] as Record<string, unknown>),
    minimumDetectableEffect,
  }
  const custom = parseManifest(raw)
  return computeVerdict({
    manifest: custom,
    metrics,
    rounds: goodCounts,
    invariants: custom.invariants.map((id) => ({ id, ok: true })),
    providerOutages: 0,
  })
}

describe('verdict matrix', () => {
  it('accepts when the target improves, guardrails hold and invariants pass', () => {
    const verdict = evaluate()
    expect(verdict.status).toBe('accepted')
    expect(verdict.target.status).toBe('pass')
    expect(verdict.guardrails.every((guardrail) => guardrail.status === 'pass')).toBe(true)
    expect(verdict.reasons.some((reason) => reason.includes('all invariants passed'))).toBe(true)
  })

  it('accepts a regression eval when its primary axis holds at the baseline', () => {
    const verdict = evaluate()
    expect(verdict.status).toBe('accepted')
    expect(verdict.target.status).toBe('pass')
    expect(verdict.target.required).toBe(0)
    expect(verdict.reasons.join('; ')).toContain('regression axis "replay.deterministic_rate" held')
  })

  it('rejects a regression eval when its primary axis regresses', () => {
    const verdict = evaluate({
      metrics: { ...goodMetrics, 'replay.deterministic_rate': 0.9 },
    })
    expect(verdict.status).toBe('rejected')
    expect(verdict.target.status).toBe('fail')
    expect(verdict.target.reason).toContain('regressed')
  })

  it('rejects a guardrail regression even when the target improves', () => {
    const improvedTarget: Record<string, number> = {
      ...goodMetrics,
      'replay.deterministic_rate': 1.5,
      'transcript.guard_violations': 1,
    }

    const verdict = evaluate({ metrics: improvedTarget })
    expect(verdict.status).toBe('rejected')
    const guardrail = verdict.guardrails.find(
      (axis) => axis.metric === 'transcript.guard_violations',
    )
    expect(guardrail?.status).toBe('fail')
    expect(verdict.reasons.join('; ')).toContain('transcript.guard_violations')
  })

  it('rejects a target regression', () => {
    const verdict = evaluate({
      metrics: { ...goodMetrics, 'replay.deterministic_rate': 0.5 },
    })
    expect(verdict.status).toBe('rejected')
    expect(verdict.target.status).toBe('fail')
  })

  it('treats an improvement below the minimum detectable effect as inconclusive, not accepted', () => {
    const verdict = withTarget(0.1, {
      ...goodMetrics,
      'replay.deterministic_rate': 1.05,
    })
    expect(verdict.target.status).toBe('inconclusive')
    expect(verdict.status).toBe('inconclusive')
  })

  it('is inconclusive when the round limit is exceeded', () => {
    const verdict = evaluate({
      rounds: { requested: 2, attempts: 3, completed: 3 },
    })
    expect(verdict.status).toBe('inconclusive')
    expect(verdict.reasons.join('; ')).toContain('exceeding the pre-registered limit')
  })

  it('is inconclusive when the failure-rate limit is exceeded', () => {
    const verdict = evaluate({
      rounds: { requested: 2, attempts: 2, completed: 1 },
    })
    expect(verdict.status).toBe('inconclusive')
    expect(verdict.reasons.join('; ')).toContain('failure rate')
  })

  it('is inconclusive when no round completed', () => {
    const verdict = evaluate({
      rounds: { requested: 2, attempts: 2, completed: 0 },
    })
    expect(verdict.status).toBe('inconclusive')
    expect(verdict.status).not.toBe('accepted')
  })

  it('marks a provider outage infrastructure_inconclusive and never passes', () => {
    const verdict = evaluate({ providerOutages: 1 })
    expect(verdict.status).toBe('infrastructure_inconclusive')
    expect(verdict.status).not.toBe('accepted')
    expect(verdict.reasons.join('; ')).toContain('never scored as "no" or zero')
  })

  it('a provider outage wins over otherwise perfect metrics and limits', () => {
    const verdict = evaluate({
      providerOutages: 1,
      metrics: { ...goodMetrics, 'replay.deterministic_rate': 2 },
    })
    expect(verdict.status).toBe('infrastructure_inconclusive')
  })

  it('rejects when a hard invariant fails', () => {
    const invariants = passingInvariants.map((invariant) =>
      invariant.id === 'transcript.guard_clean' ? { ...invariant, ok: false } : invariant,
    )

    const verdict = evaluate({ invariants })
    expect(verdict.status).toBe('rejected')
    expect(verdict.reasons.join('; ')).toContain('transcript.guard_clean')
  })

  it('is inconclusive when a registered axis was not measured', () => {
    const metrics = { ...goodMetrics }
    delete metrics['replay.deterministic_rate']

    const verdict = evaluate({ metrics })
    expect(verdict.status).toBe('inconclusive')
    expect(verdict.target.status).toBe('inconclusive')
  })

  it('is inconclusive when the manifest pre-registers no baseline readings', () => {
    const raw = loadRaw()
    delete raw['baseline']
    const unbaselined: RunManifest = parseManifest(raw)

    const verdict = computeVerdict({
      manifest: unbaselined,
      metrics: goodMetrics,
      rounds: goodCounts,
      invariants: unbaselined.invariants.map((id) => ({ id, ok: true })),
      providerOutages: 0,
    })

    expect(verdict.status).toBe('inconclusive')
    expect(verdict.target.status).toBe('inconclusive')
    expect(verdict.target.reason).toContain('no pre-registered baseline')
  })
})

const TARGET_METRIC = 'agent.task_success'
const GUARDRAIL_METRIC = 'latency.first_token_ms'

/** A complete capability manifest built inline; no fixture file is read. */
function inlineRawManifest(): Record<string, unknown> {
  return {
    schemaVersion: '3.0.0',
    run: { runId: 'verdict-inline', suite: 'verdict-inline', purpose: 'capability' },
    tasks: {
      dataset: 'synthetic-workplace',
      version: 'v1',
      languages: ['en'],
      splits: ['calibration'],
    },
    seeds: { master: 20261025, algorithm: 'mulberry32' },
    grader: { id: 'deterministic-invariants', kind: 'code', version: '1.0.0' },
    rubric: { version: 'm0-harness-v1' },
    limits: { rounds: 2, maxFailureRate: 0 },
    target: { metric: TARGET_METRIC, direction: 'increase', minimumDetectableEffect: 0.1 },
    guardrails: [{ metric: GUARDRAIL_METRIC, direction: 'decrease', tolerance: 50 }],
    invariants: ['transcript.schema_valid', 'transcript.guard_clean'],
    provider: { mode: 'canned', label: 'verdict-inline-v1', allowLive: false },
    baseline: {
      runId: 'verdict-inline-bootstrap',
      metrics: { [TARGET_METRIC]: 0.5, [GUARDRAIL_METRIC]: 900 },
    },
  }
}

function inlineManifest(patch: (raw: Record<string, unknown>) => void = () => {}): RunManifest {
  const raw = inlineRawManifest()
  patch(raw)
  return parseManifest(raw)
}

interface InlineVerdictOptions {
  readonly metrics?: Record<string, number>
  readonly rounds?: RoundCounts
  readonly invariants?: readonly InvariantResult[]
  readonly providerOutages?: number
  readonly baselineMetrics?: Record<string, number>
}

/** Defaults: target improves by 0.25, guardrail improves by 10, everything holds. */
function inlineVerdict(manifest: RunManifest, options: InlineVerdictOptions = {}): RunVerdict {
  return computeVerdict({
    manifest,
    metrics: options.metrics ?? { [TARGET_METRIC]: 0.75, [GUARDRAIL_METRIC]: 890 },
    rounds: options.rounds ?? { requested: 2, attempts: 2, completed: 2 },
    invariants:
      options.invariants ?? manifest.invariants.map((id) => ({ id, ok: true, detail: 'inline' })),
    providerOutages: options.providerOutages ?? 0,
    ...(options.baselineMetrics === undefined ? {} : { baselineMetrics: options.baselineMetrics }),
  })
}

const targetRegistration = (overrides: Partial<TargetRegistration> = {}): TargetRegistration => ({
  metric: TARGET_METRIC,
  direction: 'increase',
  minimumDetectableEffect: 0.1,
  ...overrides,
})

const guardrailRegistration = (
  overrides: Partial<GuardrailRegistration> = {},
): GuardrailRegistration => ({
  metric: GUARDRAIL_METRIC,
  direction: 'increase',
  tolerance: 0.05,
  ...overrides,
})

describe('verdict schemas', () => {
  it('exposes the four verdict statuses in precedence order', () => {
    expect(VERDICT_STATUSES).toStrictEqual([
      'accepted',
      'rejected',
      'inconclusive',
      'infrastructure_inconclusive',
    ])
    for (const status of VERDICT_STATUSES) {
      expect(verdictStatusSchema.parse(status)).toBe(status)
    }
    expect(verdictStatusSchema.safeParse('passed').success).toBe(false)
    expect(verdictStatusSchema.safeParse('').success).toBe(false)
  })

  it('only accepts the two axis kinds and three axis statuses', () => {
    expect(axisKindSchema.parse('target')).toBe('target')
    expect(axisKindSchema.parse('guardrail')).toBe('guardrail')
    expect(axisKindSchema.safeParse('axis').success).toBe(false)

    expect(axisStatusSchema.parse('pass')).toBe('pass')
    expect(axisStatusSchema.parse('fail')).toBe('fail')
    expect(axisStatusSchema.parse('inconclusive')).toBe('inconclusive')
    expect(axisStatusSchema.safeParse('accepted').success).toBe(false)
  })

  it('validates a full axis verdict and rejects unknown keys or non-finite numbers', () => {
    const axis: AxisVerdict = {
      kind: 'target',
      metric: TARGET_METRIC,
      direction: 'increase',
      baseline: 0.5,
      value: 0.75,
      delta: 0.25,
      improvement: 0.25,
      required: 0.1,
      status: 'pass',
      reason: 'target metric "agent.task_success" improved by 0.25 (required 0.1)',
    }

    expect(axisVerdictSchema.parse(axis)).toStrictEqual(axis)
    expect(axisVerdictSchema.safeParse({ ...axis, extra: true }).success).toBe(false)
    expect(axisVerdictSchema.safeParse({ ...axis, value: Number.NaN }).success).toBe(false)
    expect(axisVerdictSchema.safeParse({ ...axis, delta: Number.POSITIVE_INFINITY }).success).toBe(
      false,
    )
    expect(axisVerdictSchema.safeParse({ ...axis, reason: '' }).success).toBe(false)
    expect(axisVerdictSchema.safeParse({ kind: 'target' }).success).toBe(false)
  })

  it('accepts an axis without measured values but keeps required and reason mandatory', () => {
    const axis: AxisVerdict = {
      kind: 'guardrail',
      metric: GUARDRAIL_METRIC,
      direction: 'decrease',
      required: 50,
      status: 'inconclusive',
      reason: 'guardrail "latency.first_token_ms" was not measured',
    }

    expect(axisVerdictSchema.parse(axis)).toStrictEqual(axis)
    expect(axisVerdictSchema.safeParse({ ...axis, required: undefined }).success).toBe(false)
    expect(axisVerdictSchema.safeParse({ ...axis, status: undefined }).success).toBe(false)
  })

  it('validates a whole run verdict and rejects unknown keys and invalid counts', () => {
    const verdict = inlineVerdict(inlineManifest())

    expect(runVerdictSchema.parse(verdict)).toStrictEqual(verdict)
    expect(runVerdictSchema.safeParse({ ...verdict, extra: true }).success).toBe(false)
    expect(runVerdictSchema.safeParse({ ...verdict, providerOutages: -1 }).success).toBe(false)
    expect(runVerdictSchema.safeParse({ ...verdict, providerOutages: 1.5 }).success).toBe(false)
    expect(runVerdictSchema.safeParse({ ...verdict, reasons: [''] }).success).toBe(false)
    expect(runVerdictSchema.safeParse({ ...verdict, target: undefined }).success).toBe(false)
  })
})

describe('evaluateTargetAxis', () => {
  const baseline = { [TARGET_METRIC]: 0.5 }

  it('marks a missing measurement inconclusive without inventing a value', () => {
    expect(evaluateTargetAxis(targetRegistration(), baseline, {})).toStrictEqual({
      kind: 'target',
      metric: TARGET_METRIC,
      direction: 'increase',
      baseline: 0.5,
      required: 0.1,
      status: 'inconclusive',
      reason: `target metric "${TARGET_METRIC}" was not measured`,
    })
  })

  it('marks a missing baseline reading inconclusive and keeps the measured value', () => {
    expect(evaluateTargetAxis(targetRegistration(), {}, { [TARGET_METRIC]: 0.7 })).toStrictEqual({
      kind: 'target',
      metric: TARGET_METRIC,
      direction: 'increase',
      value: 0.7,
      required: 0.1,
      status: 'inconclusive',
      reason: `target metric "${TARGET_METRIC}" has no pre-registered baseline reading`,
    })
  })

  it('passes an increase target that clears the minimum detectable effect', () => {
    expect(
      evaluateTargetAxis(targetRegistration(), baseline, { [TARGET_METRIC]: 0.75 }),
    ).toStrictEqual({
      kind: 'target',
      metric: TARGET_METRIC,
      direction: 'increase',
      baseline: 0.5,
      value: 0.75,
      delta: 0.25,
      improvement: 0.25,
      required: 0.1,
      status: 'pass',
      reason: `target metric "${TARGET_METRIC}" improved by 0.25 (required 0.1)`,
    })
  })

  it('passes a decrease target whose value falls', () => {
    const registration = targetRegistration({ metric: 'agent.latency_ms', direction: 'decrease' })
    const verdict = evaluateTargetAxis(
      registration,
      { 'agent.latency_ms': 100 },
      { 'agent.latency_ms': 90 },
    )

    expect(verdict).toStrictEqual({
      kind: 'target',
      metric: 'agent.latency_ms',
      direction: 'decrease',
      baseline: 100,
      value: 90,
      delta: -10,
      improvement: 10,
      required: 0.1,
      status: 'pass',
      reason: 'target metric "agent.latency_ms" improved by 10 (required 0.1)',
    })
  })

  it('treats an unchanged axis as inconclusive, reporting a zero improvement', () => {
    expect(
      evaluateTargetAxis(targetRegistration(), baseline, { [TARGET_METRIC]: 0.5 }),
    ).toStrictEqual({
      kind: 'target',
      metric: TARGET_METRIC,
      direction: 'increase',
      baseline: 0.5,
      value: 0.5,
      delta: 0,
      improvement: 0,
      required: 0.1,
      status: 'inconclusive',
      reason: `target metric "${TARGET_METRIC}" improved by 0, below the registered minimum detectable effect 0.1`,
    })
  })

  it('fails an increase target that regresses and reports the positive regression size', () => {
    const delta = 0.3 - 0.5

    expect(
      evaluateTargetAxis(targetRegistration(), baseline, { [TARGET_METRIC]: 0.3 }),
    ).toStrictEqual({
      kind: 'target',
      metric: TARGET_METRIC,
      direction: 'increase',
      baseline: 0.5,
      value: 0.3,
      delta,
      improvement: delta,
      required: 0.1,
      status: 'fail',
      reason: `target metric "${TARGET_METRIC}" regressed by 0.2`,
    })
  })

  it('fails a decrease target that rises', () => {
    const registration = targetRegistration({ metric: 'agent.latency_ms', direction: 'decrease' })
    const delta = 120 - 100

    expect(
      evaluateTargetAxis(registration, { 'agent.latency_ms': 100 }, { 'agent.latency_ms': 120 }),
    ).toStrictEqual({
      kind: 'target',
      metric: 'agent.latency_ms',
      direction: 'decrease',
      baseline: 100,
      value: 120,
      delta,
      improvement: -delta,
      required: 0.1,
      status: 'fail',
      reason: 'target metric "agent.latency_ms" regressed by 20',
    })
  })

  it('is inconclusive just below the minimum detectable effect and passes exactly at it', () => {
    const below = evaluateTargetAxis(
      targetRegistration(),
      { [TARGET_METRIC]: 0 },
      { [TARGET_METRIC]: 0.099 },
    )
    expect(below.status).toBe('inconclusive')
    expect(below.reason).toBe(
      `target metric "${TARGET_METRIC}" improved by 0.099, below the registered minimum detectable effect 0.1`,
    )

    const at = evaluateTargetAxis(
      targetRegistration(),
      { [TARGET_METRIC]: 0 },
      { [TARGET_METRIC]: 0.1 },
    )
    expect(at.status).toBe('pass')
    expect(at.reason).toBe(`target metric "${TARGET_METRIC}" improved by 0.1 (required 0.1)`)

    const above = evaluateTargetAxis(
      targetRegistration(),
      { [TARGET_METRIC]: 0 },
      { [TARGET_METRIC]: 0.2 },
    )
    expect(above.status).toBe('pass')
    expect(above.reason).toBe(`target metric "${TARGET_METRIC}" improved by 0.2 (required 0.1)`)
  })

  it('treats a regression of exactly one epsilon as not yet a regression', () => {
    const verdict = evaluateTargetAxis(
      targetRegistration(),
      { [TARGET_METRIC]: 0 },
      { [TARGET_METRIC]: -1e-12 },
    )

    expect(verdict.status).toBe('inconclusive')
    expect(verdict.improvement).toBe(-1e-12)
    expect(verdict.reason).toBe(
      `target metric "${TARGET_METRIC}" improved by 0, below the registered minimum detectable effect 0.1`,
    )
  })

  it('treats a sub-epsilon improvement as no improvement at all', () => {
    const verdict = evaluateTargetAxis(
      targetRegistration(),
      { [TARGET_METRIC]: 0 },
      { [TARGET_METRIC]: 5e-13 },
    )

    expect(verdict.status).toBe('inconclusive')
    expect(verdict.improvement).toBe(5e-13)
  })

  it('passes when the improvement lands within one epsilon below the MDE', () => {
    const verdict = evaluateTargetAxis(
      targetRegistration({ minimumDetectableEffect: 2e-12 }),
      { [TARGET_METRIC]: 0 },
      { [TARGET_METRIC]: 1e-12 },
    )

    expect(verdict).toStrictEqual({
      kind: 'target',
      metric: TARGET_METRIC,
      direction: 'increase',
      baseline: 0,
      value: 1e-12,
      delta: 1e-12,
      improvement: 1e-12,
      required: 2e-12,
      status: 'pass',
      reason: `target metric "${TARGET_METRIC}" improved by 0 (required 0)`,
    })
  })

  it('passes a zero-effect target when the registered MDE is zero', () => {
    const verdict = evaluateTargetAxis(
      targetRegistration({ minimumDetectableEffect: 0 }),
      baseline,
      { [TARGET_METRIC]: 0.5 },
    )

    expect(verdict.status).toBe('pass')
    expect(verdict.reason).toBe(`target metric "${TARGET_METRIC}" improved by 0 (required 0)`)
  })

  it('rounds a fractional improvement to six decimal places', () => {
    const verdict = evaluateTargetAxis(
      targetRegistration(),
      { [TARGET_METRIC]: 0 },
      { [TARGET_METRIC]: 0.123456789 },
    )

    expect(verdict.status).toBe('pass')
    expect(verdict.reason).toBe(
      `target metric "${TARGET_METRIC}" improved by 0.123457 (required 0.1)`,
    )
  })

  it('prints integers without a decimal part and large values in full', () => {
    const integer = evaluateTargetAxis(
      targetRegistration(),
      { [TARGET_METRIC]: 0 },
      { [TARGET_METRIC]: 42 },
    )
    expect(integer.reason).toBe(`target metric "${TARGET_METRIC}" improved by 42 (required 0.1)`)

    const large = evaluateTargetAxis(
      targetRegistration(),
      { [TARGET_METRIC]: 0 },
      { [TARGET_METRIC]: Number('987654321.123456') },
    )
    expect(large.reason).toBe(
      `target metric "${TARGET_METRIC}" improved by 987654321.123456 (required 0.1)`,
    )
  })
})

describe('evaluateRegressionAxis', () => {
  const baseline = { [TARGET_METRIC]: 0.5 }

  it('marks a missing measurement inconclusive with a zero requirement', () => {
    expect(evaluateRegressionAxis(targetRegistration(), baseline, {})).toStrictEqual({
      kind: 'target',
      metric: TARGET_METRIC,
      direction: 'increase',
      baseline: 0.5,
      required: 0,
      status: 'inconclusive',
      reason: `regression axis "${TARGET_METRIC}" was not measured`,
    })
  })

  it('marks a missing baseline reading inconclusive with a zero requirement', () => {
    expect(
      evaluateRegressionAxis(targetRegistration(), {}, { [TARGET_METRIC]: 0.6 }),
    ).toStrictEqual({
      kind: 'target',
      metric: TARGET_METRIC,
      direction: 'increase',
      value: 0.6,
      required: 0,
      status: 'inconclusive',
      reason: `regression axis "${TARGET_METRIC}" has no pre-registered baseline reading`,
    })
  })

  it('passes an axis held exactly at its baseline', () => {
    expect(
      evaluateRegressionAxis(targetRegistration(), baseline, { [TARGET_METRIC]: 0.5 }),
    ).toStrictEqual({
      kind: 'target',
      metric: TARGET_METRIC,
      direction: 'increase',
      baseline: 0.5,
      value: 0.5,
      delta: 0,
      improvement: 0,
      required: 0,
      status: 'pass',
      reason: `regression axis "${TARGET_METRIC}" held`,
    })
  })

  it('passes and reports an improvement', () => {
    expect(
      evaluateRegressionAxis(targetRegistration(), baseline, { [TARGET_METRIC]: 0.75 }),
    ).toStrictEqual({
      kind: 'target',
      metric: TARGET_METRIC,
      direction: 'increase',
      baseline: 0.5,
      value: 0.75,
      delta: 0.25,
      improvement: 0.25,
      required: 0,
      status: 'pass',
      reason: `regression axis "${TARGET_METRIC}" held and improved by 0.25`,
    })
  })

  it('does not call an improvement of exactly one epsilon an improvement', () => {
    const verdict = evaluateRegressionAxis(
      targetRegistration(),
      { [TARGET_METRIC]: 0 },
      { [TARGET_METRIC]: 1e-12 },
    )

    expect(verdict.status).toBe('pass')
    expect(verdict.reason).toBe(`regression axis "${TARGET_METRIC}" held`)
  })

  it('does not fail a regression axis at exactly one epsilon of regression', () => {
    expect(
      evaluateRegressionAxis(
        targetRegistration(),
        { [TARGET_METRIC]: 0 },
        { [TARGET_METRIC]: -1e-12 },
      ),
    ).toStrictEqual({
      kind: 'target',
      metric: TARGET_METRIC,
      direction: 'increase',
      baseline: 0,
      value: -1e-12,
      delta: -1e-12,
      improvement: -1e-12,
      required: 0,
      status: 'pass',
      reason: `regression axis "${TARGET_METRIC}" held`,
    })
  })

  it('fails and reports the regression size when the axis moves the wrong way', () => {
    const delta = 0.3 - 0.5

    expect(
      evaluateRegressionAxis(targetRegistration(), baseline, { [TARGET_METRIC]: 0.3 }),
    ).toStrictEqual({
      kind: 'target',
      metric: TARGET_METRIC,
      direction: 'increase',
      baseline: 0.5,
      value: 0.3,
      delta,
      improvement: delta,
      required: 0,
      status: 'fail',
      reason: `regression axis "${TARGET_METRIC}" regressed by 0.2`,
    })
  })

  it('handles a decrease axis in both directions', () => {
    const registration = targetRegistration({ metric: 'agent.latency_ms', direction: 'decrease' })

    const held = evaluateRegressionAxis(
      registration,
      { 'agent.latency_ms': 100 },
      { 'agent.latency_ms': 90 },
    )
    expect(held.status).toBe('pass')
    expect(held.delta).toBe(-10)
    expect(held.improvement).toBe(10)
    expect(held.reason).toBe('regression axis "agent.latency_ms" held and improved by 10')

    const failed = evaluateRegressionAxis(
      registration,
      { 'agent.latency_ms': 100 },
      { 'agent.latency_ms': 120 },
    )
    expect(failed.status).toBe('fail')
    expect(failed.delta).toBe(20)
    expect(failed.improvement).toBe(-20)
    expect(failed.reason).toBe('regression axis "agent.latency_ms" regressed by 20')
  })

  it('reports a negative delta in the accepted reason for a decrease regression axis', () => {
    const verdict = inlineVerdict(
      inlineManifest((raw) => {
        ;(raw['run'] as Record<string, unknown>)['purpose'] = 'regression'
        raw['target'] = {
          metric: 'agent.latency_ms',
          direction: 'decrease',
          minimumDetectableEffect: 0,
        }
        raw['baseline'] = {
          runId: 'verdict-inline-bootstrap',
          metrics: { 'agent.latency_ms': 100, [GUARDRAIL_METRIC]: 900 },
        }
      }),
      { metrics: { 'agent.latency_ms': 95, [GUARDRAIL_METRIC]: 890 } },
    )

    expect(verdict.status).toBe('accepted')
    expect(verdict.reasons).toStrictEqual([
      'regression axis "agent.latency_ms" held (delta -5), 1 guardrail(s) held and all invariants passed',
    ])
  })
})

describe('evaluateGuardrailAxis', () => {
  const baseline = { [GUARDRAIL_METRIC]: 1 }

  it('marks a missing measurement inconclusive', () => {
    expect(evaluateGuardrailAxis(guardrailRegistration(), baseline, {})).toStrictEqual({
      kind: 'guardrail',
      metric: GUARDRAIL_METRIC,
      direction: 'increase',
      baseline: 1,
      required: 0.05,
      status: 'inconclusive',
      reason: `guardrail "${GUARDRAIL_METRIC}" was not measured`,
    })
  })

  it('marks a missing baseline reading inconclusive and keeps the measured value', () => {
    expect(
      evaluateGuardrailAxis(guardrailRegistration(), {}, { [GUARDRAIL_METRIC]: 1 }),
    ).toStrictEqual({
      kind: 'guardrail',
      metric: GUARDRAIL_METRIC,
      direction: 'increase',
      value: 1,
      required: 0.05,
      status: 'inconclusive',
      reason: `guardrail "${GUARDRAIL_METRIC}" has no pre-registered baseline reading`,
    })
  })

  it('passes an unchanged axis with a held reason', () => {
    expect(
      evaluateGuardrailAxis(guardrailRegistration(), baseline, { [GUARDRAIL_METRIC]: 1 }),
    ).toStrictEqual({
      kind: 'guardrail',
      metric: GUARDRAIL_METRIC,
      direction: 'increase',
      baseline: 1,
      value: 1,
      delta: 0,
      improvement: 0,
      required: 0.05,
      status: 'pass',
      reason: `guardrail "${GUARDRAIL_METRIC}" held`,
    })
  })

  it('passes and reports a held reason when the guardrail improves', () => {
    const verdict = evaluateGuardrailAxis(guardrailRegistration(), baseline, {
      [GUARDRAIL_METRIC]: 1.1,
    })

    expect(verdict.status).toBe('pass')
    expect(verdict.delta).toBe(1.1 - 1)
    expect(verdict.improvement).toBe(1.1 - 1)
    expect(verdict.reason).toBe(`guardrail "${GUARDRAIL_METRIC}" held`)
  })

  it('passes a regression exactly at the tolerance', () => {
    const verdict = evaluateGuardrailAxis(
      guardrailRegistration({ tolerance: 0.05 }),
      { [GUARDRAIL_METRIC]: 1 },
      { [GUARDRAIL_METRIC]: 0.95 },
    )

    expect(verdict.status).toBe('pass')
    expect(verdict.reason).toBe(
      `guardrail "${GUARDRAIL_METRIC}" regressed by 0.05, within the tolerated 0.05`,
    )
  })

  it('passes a regression just below, and fails just above, the tolerance', () => {
    const below = evaluateGuardrailAxis(
      guardrailRegistration({ tolerance: 0.05 }),
      { [GUARDRAIL_METRIC]: 1 },
      { [GUARDRAIL_METRIC]: 0.96 },
    )
    expect(below.status).toBe('pass')
    expect(below.reason).toBe(
      `guardrail "${GUARDRAIL_METRIC}" regressed by 0.04, within the tolerated 0.05`,
    )

    const above = evaluateGuardrailAxis(
      guardrailRegistration({ tolerance: 0.05 }),
      { [GUARDRAIL_METRIC]: 1 },
      { [GUARDRAIL_METRIC]: 0.94 },
    )
    expect(above.status).toBe('fail')
    expect(above.reason).toBe(
      `guardrail "${GUARDRAIL_METRIC}" regressed by 0.06, beyond the tolerated 0.05`,
    )
  })

  it('passes a regression of exactly one epsilon beyond a zero tolerance', () => {
    const verdict = evaluateGuardrailAxis(
      guardrailRegistration({ tolerance: 0 }),
      { [GUARDRAIL_METRIC]: 0 },
      { [GUARDRAIL_METRIC]: -1e-12 },
    )

    expect(verdict).toStrictEqual({
      kind: 'guardrail',
      metric: GUARDRAIL_METRIC,
      direction: 'increase',
      baseline: 0,
      value: -1e-12,
      delta: -1e-12,
      improvement: -1e-12,
      required: 0,
      status: 'pass',
      reason: `guardrail "${GUARDRAIL_METRIC}" regressed by 0, within the tolerated 0`,
    })
  })

  it('handles a decrease guardrail in both directions', () => {
    const registration = guardrailRegistration({ direction: 'decrease', tolerance: 0.05 })

    const failed = evaluateGuardrailAxis(
      registration,
      { [GUARDRAIL_METRIC]: 1 },
      { [GUARDRAIL_METRIC]: 1.1 },
    )
    expect(failed.status).toBe('fail')
    expect(failed.improvement).toBe(1 - 1.1)
    expect(failed.reason).toBe(
      `guardrail "${GUARDRAIL_METRIC}" regressed by 0.1, beyond the tolerated 0.05`,
    )

    const held = evaluateGuardrailAxis(
      registration,
      { [GUARDRAIL_METRIC]: 1 },
      { [GUARDRAIL_METRIC]: 0.9 },
    )
    expect(held.status).toBe('pass')
    expect(held.reason).toBe(`guardrail "${GUARDRAIL_METRIC}" held`)
  })
})

describe('computeVerdict', () => {
  it('accepts a capability run that clears the MDE with every guardrail and invariant held', () => {
    expect(inlineVerdict(inlineManifest())).toStrictEqual({
      status: 'accepted',
      target: {
        kind: 'target',
        metric: TARGET_METRIC,
        direction: 'increase',
        baseline: 0.5,
        value: 0.75,
        delta: 0.25,
        improvement: 0.25,
        required: 0.1,
        status: 'pass',
        reason: `target metric "${TARGET_METRIC}" improved by 0.25 (required 0.1)`,
      },
      guardrails: [
        {
          kind: 'guardrail',
          metric: GUARDRAIL_METRIC,
          direction: 'decrease',
          baseline: 900,
          value: 890,
          delta: -10,
          improvement: 10,
          required: 50,
          status: 'pass',
          reason: `guardrail "${GUARDRAIL_METRIC}" held`,
        },
      ],
      invariants: [
        { id: 'transcript.schema_valid', ok: true, detail: 'inline' },
        { id: 'transcript.guard_clean', ok: true, detail: 'inline' },
      ],
      reasons: [
        `target "${TARGET_METRIC}" improved by 0.25 (required 0.1), 1 guardrail(s) held and all invariants passed`,
      ],
      providerOutages: 0,
    })
  })

  it('accepts a regression run whose primary axis improves and reports its delta', () => {
    const manifest = inlineManifest((raw) => {
      ;(raw['run'] as Record<string, unknown>)['purpose'] = 'regression'
      ;(raw['target'] as Record<string, unknown>)['minimumDetectableEffect'] = 0
    })

    const verdict = inlineVerdict(manifest)
    expect(verdict.status).toBe('accepted')
    expect(verdict.target.required).toBe(0)
    expect(verdict.reasons).toStrictEqual([
      `regression axis "${TARGET_METRIC}" held (delta 0.25), 1 guardrail(s) held and all invariants passed`,
    ])
  })

  it('accepts a regression run held at its baseline with a zero delta', () => {
    const manifest = inlineManifest((raw) => {
      ;(raw['run'] as Record<string, unknown>)['purpose'] = 'regression'
      ;(raw['target'] as Record<string, unknown>)['minimumDetectableEffect'] = 0
    })

    const verdict = inlineVerdict(manifest, {
      metrics: { [TARGET_METRIC]: 0.5, [GUARDRAIL_METRIC]: 890 },
    })
    expect(verdict.status).toBe('accepted')
    expect(verdict.target.reason).toBe(`regression axis "${TARGET_METRIC}" held`)
    expect(verdict.reasons).toStrictEqual([
      `regression axis "${TARGET_METRIC}" held (delta 0), 1 guardrail(s) held and all invariants passed`,
    ])
  })

  it('rejects a failing target with exactly the target reason', () => {
    const verdict = inlineVerdict(inlineManifest(), {
      metrics: { [TARGET_METRIC]: 0.4, [GUARDRAIL_METRIC]: 890 },
    })

    expect(verdict.status).toBe('rejected')
    expect(verdict.reasons).toStrictEqual([`target metric "${TARGET_METRIC}" regressed by 0.1`])
  })

  it('rejects a failing guardrail with exactly the guardrail reason', () => {
    const verdict = inlineVerdict(inlineManifest(), {
      metrics: { [TARGET_METRIC]: 0.75, [GUARDRAIL_METRIC]: 1000 },
    })

    expect(verdict.status).toBe('rejected')
    expect(verdict.guardrails[0]?.status).toBe('fail')
    expect(verdict.reasons).toStrictEqual([
      `guardrail "${GUARDRAIL_METRIC}" regressed by 100, beyond the tolerated 50`,
    ])
  })

  it('orders the guardrail reason before the target reason', () => {
    const verdict = inlineVerdict(inlineManifest(), {
      metrics: { [TARGET_METRIC]: 0.4, [GUARDRAIL_METRIC]: 1000 },
    })

    expect(verdict.status).toBe('rejected')
    expect(verdict.reasons).toStrictEqual([
      `guardrail "${GUARDRAIL_METRIC}" regressed by 100, beyond the tolerated 50`,
      `target metric "${TARGET_METRIC}" regressed by 0.1`,
    ])
  })

  it('rejects a failed invariant and names every failed id', () => {
    const verdict = inlineVerdict(inlineManifest(), {
      invariants: [
        { id: 'transcript.schema_valid', ok: false },
        { id: 'transcript.guard_clean', ok: false },
      ],
    })

    expect(verdict.status).toBe('rejected')
    expect(verdict.reasons).toStrictEqual([
      'invariant(s) failed: transcript.schema_valid, transcript.guard_clean',
    ])
  })

  it('turns a registered invariant with no result into a hard failure', () => {
    const verdict = inlineVerdict(inlineManifest(), { invariants: [] })

    expect(verdict.status).toBe('rejected')
    expect(verdict.invariants).toStrictEqual([
      {
        id: 'transcript.schema_valid',
        ok: false,
        detail: 'invariant was registered but not measured',
      },
      {
        id: 'transcript.guard_clean',
        ok: false,
        detail: 'invariant was registered but not measured',
      },
    ])
    expect(verdict.reasons).toStrictEqual([
      'invariant(s) failed: transcript.schema_valid, transcript.guard_clean',
    ])
  })

  it('drops an unregistered invariant and keeps the manifest order', () => {
    const manifest = inlineManifest((raw) => {
      raw['invariants'] = ['transcript.guard_clean', 'transcript.schema_valid']
    })

    const verdict = inlineVerdict(manifest, {
      invariants: [
        { id: 'transcript.schema_valid', ok: true },
        { id: 'transcript.seq_monotonic', ok: false },
        { id: 'transcript.guard_clean', ok: true },
      ],
    })

    expect(verdict.status).toBe('accepted')
    expect(verdict.invariants).toStrictEqual([
      { id: 'transcript.guard_clean', ok: true },
      { id: 'transcript.schema_valid', ok: true },
    ])
  })

  it('is inconclusive when the target was not measured', () => {
    const verdict = inlineVerdict(inlineManifest(), {
      metrics: { [GUARDRAIL_METRIC]: 890 },
    })

    expect(verdict.status).toBe('inconclusive')
    expect(verdict.target.status).toBe('inconclusive')
    expect(verdict.reasons).toStrictEqual([
      `target metric "${TARGET_METRIC}" was not measured`,
      'the run is inconclusive; it is not an acceptance',
    ])
  })

  it('is inconclusive when a guardrail was not measured, after the passing target', () => {
    const verdict = inlineVerdict(inlineManifest(), {
      metrics: { [TARGET_METRIC]: 0.75 },
    })

    expect(verdict.status).toBe('inconclusive')
    expect(verdict.target.status).toBe('pass')
    expect(verdict.guardrails[0]?.status).toBe('inconclusive')
    expect(verdict.reasons).toStrictEqual([
      `guardrail "${GUARDRAIL_METRIC}" was not measured`,
      'the run is inconclusive; it is not an acceptance',
    ])
  })

  it('keeps the target inconclusive reason ahead of the guardrail inconclusive reason', () => {
    const verdict = inlineVerdict(inlineManifest(), { metrics: {} })

    expect(verdict.status).toBe('inconclusive')
    expect(verdict.reasons).toStrictEqual([
      `target metric "${TARGET_METRIC}" was not measured`,
      `guardrail "${GUARDRAIL_METRIC}" was not measured`,
      'the run is inconclusive; it is not an acceptance',
    ])
  })

  it('marks any provider outage infrastructure-inconclusive and passes the count through', () => {
    const verdict = inlineVerdict(inlineManifest(), { providerOutages: 3 })

    expect(verdict.status).toBe('infrastructure_inconclusive')
    expect(verdict.providerOutages).toBe(3)
    expect(verdict.reasons).toStrictEqual([
      '3 provider call(s) failed; provider outages are infrastructure-inconclusive and are never scored as "no" or zero',
      'the run is infrastructure-inconclusive; re-run when providers are healthy',
    ])
  })

  it('is inconclusive when more rounds were attempted than registered', () => {
    const verdict = inlineVerdict(inlineManifest(), {
      rounds: { requested: 1, attempts: 2, completed: 2 },
    })

    expect(verdict.status).toBe('inconclusive')
    expect(verdict.reasons).toStrictEqual([
      'attempted 2 rounds, exceeding the pre-registered limit of 1',
      'the run is inconclusive; it is not an acceptance',
    ])
  })

  it('lets an over-attempt inconclusive beat a failing invariant', () => {
    const verdict = inlineVerdict(inlineManifest(), {
      rounds: { requested: 1, attempts: 2, completed: 2 },
      invariants: [
        { id: 'transcript.schema_valid', ok: false },
        { id: 'transcript.guard_clean', ok: true },
      ],
    })

    expect(verdict.status).toBe('inconclusive')
    expect(verdict.reasons).toStrictEqual([
      'attempted 2 rounds, exceeding the pre-registered limit of 1',
      'invariant(s) failed: transcript.schema_valid',
      'the run is inconclusive; it is not an acceptance',
    ])
  })

  it('reports the measured failure rate, not a product of the counts', () => {
    const verdict = inlineVerdict(inlineManifest(), {
      rounds: { requested: 2, attempts: 2, completed: 1 },
    })

    expect(verdict.status).toBe('inconclusive')
    expect(verdict.reasons).toStrictEqual([
      'failure rate 0.5 exceeds the registered limit 0',
      'the run is inconclusive; it is not an acceptance',
    ])
  })

  it('uses a failure rate of one when no round was attempted', () => {
    const verdict = inlineVerdict(inlineManifest(), {
      rounds: { requested: 0, attempts: 0, completed: 0 },
    })

    expect(verdict.status).toBe('inconclusive')
    expect(verdict.reasons).toStrictEqual([
      'failure rate 1 exceeds the registered limit 0',
      'no round completed successfully, so there is nothing to score',
      'the run is inconclusive; it is not an acceptance',
    ])
  })

  it('does not exceed the failure limit at exactly the limit plus one epsilon', () => {
    const manifest = inlineManifest((raw) => {
      raw['limits'] = { rounds: 2, maxFailureRate: 0.5 - 1e-12 }
    })

    const verdict = inlineVerdict(manifest, {
      rounds: { requested: 2, attempts: 2, completed: 1 },
    })

    expect(verdict.status).toBe('accepted')
    expect(verdict.reasons).toStrictEqual([
      `target "${TARGET_METRIC}" improved by 0.25 (required 0.1), 1 guardrail(s) held and all invariants passed`,
    ])
  })

  it('is inconclusive when no round completed', () => {
    const verdict = inlineVerdict(inlineManifest(), {
      rounds: { requested: 2, attempts: 2, completed: 0 },
    })

    expect(verdict.status).toBe('inconclusive')
    expect(verdict.reasons).toStrictEqual([
      'failure rate 1 exceeds the registered limit 0',
      'no round completed successfully, so there is nothing to score',
      'the run is inconclusive; it is not an acceptance',
    ])
  })

  it('is inconclusive with zero completed rounds even when the failure limit is not exceeded', () => {
    const manifest = inlineManifest((raw) => {
      raw['limits'] = { rounds: 1, maxFailureRate: 1 }
    })

    const verdict = inlineVerdict(manifest, {
      rounds: { requested: 1, attempts: 0, completed: 0 },
    })

    expect(verdict.status).toBe('inconclusive')
    expect(verdict.reasons).toStrictEqual([
      'no round completed successfully, so there is nothing to score',
      'the run is inconclusive; it is not an acceptance',
    ])
  })

  it('is inconclusive when one guardrail is inconclusive and another passes', () => {
    const manifest = inlineManifest((raw) => {
      raw['guardrails'] = [
        { metric: GUARDRAIL_METRIC, direction: 'decrease', tolerance: 50 },
        { metric: 'transcript.schema_valid_rate', direction: 'increase', tolerance: 0 },
      ]
    })

    const verdict = inlineVerdict(manifest, {
      metrics: { [TARGET_METRIC]: 0.75, [GUARDRAIL_METRIC]: 890 },
    })

    expect(verdict.status).toBe('inconclusive')
    expect(verdict.guardrails.map((guardrail) => guardrail.status)).toStrictEqual([
      'pass',
      'inconclusive',
    ])
    expect(verdict.reasons).toStrictEqual([
      'guardrail "transcript.schema_valid_rate" was not measured',
      'the run is inconclusive; it is not an acceptance',
    ])
  })

  it('lets a failing target beat an inconclusive guardrail', () => {
    const verdict = inlineVerdict(inlineManifest(), {
      metrics: { [TARGET_METRIC]: 0.4 },
    })

    expect(verdict.status).toBe('rejected')
    expect(verdict.reasons).toStrictEqual([
      `target metric "${TARGET_METRIC}" regressed by 0.1`,
      `guardrail "${GUARDRAIL_METRIC}" was not measured`,
    ])
  })

  it('uses an explicit baseline override instead of the manifest readings', () => {
    const manifest = inlineManifest()
    const verdict = inlineVerdict(manifest, {
      metrics: { [TARGET_METRIC]: 0.55, [GUARDRAIL_METRIC]: 890 },
      baselineMetrics: { [TARGET_METRIC]: 0.45, [GUARDRAIL_METRIC]: 900 },
    })

    expect(verdict.status).toBe('accepted')
    expect(verdict.target.baseline).toBe(0.45)
    expect(verdict.target.delta).toBe(0.55 - 0.45)
    expect(verdict.target.reason).toBe(
      `target metric "${TARGET_METRIC}" improved by 0.1 (required 0.1)`,
    )
  })

  it('replaces, rather than merges, manifest baselines when an override is given', () => {
    const manifest = inlineManifest()
    const verdict = inlineVerdict(manifest, {
      metrics: { [TARGET_METRIC]: 0.75, [GUARDRAIL_METRIC]: 890 },
      baselineMetrics: { [TARGET_METRIC]: 0.5 },
    })

    expect(verdict.target.status).toBe('pass')
    expect(verdict.guardrails[0]?.status).toBe('inconclusive')
    expect(verdict.guardrails[0]?.reason).toBe(
      `guardrail "${GUARDRAIL_METRIC}" has no pre-registered baseline reading`,
    )
    expect(verdict.status).toBe('inconclusive')
  })

  it('orders every reason: outage, limits, invariants, guardrails, target, status', () => {
    const manifest = inlineManifest((raw) => {
      raw['guardrails'] = [
        { metric: GUARDRAIL_METRIC, direction: 'decrease', tolerance: 50 },
        { metric: 'transcript.schema_valid_rate', direction: 'increase', tolerance: 0 },
      ]
    })

    const verdict = inlineVerdict(manifest, {
      metrics: { [TARGET_METRIC]: 0.4, [GUARDRAIL_METRIC]: 1000 },
      rounds: { requested: 1, attempts: 3, completed: 0 },
      invariants: [
        { id: 'transcript.schema_valid', ok: false },
        { id: 'transcript.guard_clean', ok: false },
      ],
      providerOutages: 2,
    })

    expect(verdict.status).toBe('infrastructure_inconclusive')
    expect(verdict.reasons).toStrictEqual([
      '2 provider call(s) failed; provider outages are infrastructure-inconclusive and are never scored as "no" or zero',
      'attempted 3 rounds, exceeding the pre-registered limit of 1',
      'failure rate 1 exceeds the registered limit 0',
      'no round completed successfully, so there is nothing to score',
      'invariant(s) failed: transcript.schema_valid, transcript.guard_clean',
      `guardrail "${GUARDRAIL_METRIC}" regressed by 100, beyond the tolerated 50`,
      `target metric "${TARGET_METRIC}" regressed by 0.1`,
      'guardrail "transcript.schema_valid_rate" was not measured',
      'the run is infrastructure-inconclusive; re-run when providers are healthy',
    ])
  })
})
