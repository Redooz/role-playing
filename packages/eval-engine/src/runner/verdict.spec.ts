import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { computeVerdict, type RepetitionCounts, type VerdictInput } from './verdict.js'
import { parseManifest, type InvariantResult, type RunManifest } from './manifest.js'

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
  detail: 'test fixture',
}))

const goodCounts: RepetitionCounts = { requested: 2, attempts: 2, completed: 2 }

function evaluate(overrides: Partial<VerdictInput> = {}): ReturnType<typeof computeVerdict> {
  return computeVerdict({
    manifest,
    metrics: goodMetrics,
    repetitions: goodCounts,
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
  raw['target'] = {
    ...(raw['target'] as Record<string, unknown>),
    minimumDetectableEffect,
  }
  const custom = parseManifest(raw)
  return computeVerdict({
    manifest: custom,
    metrics,
    repetitions: goodCounts,
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

  it('rejects a guardrail regression even when the target improves', () => {
    const improvedTarget: Record<string, number> = {
      ...goodMetrics,
      'replay.deterministic_rate': 1.5,
      'trace.guard_violations': 1,
    }

    const verdict = evaluate({ metrics: improvedTarget })
    expect(verdict.status).toBe('rejected')
    const guardrail = verdict.guardrails.find((axis) => axis.metric === 'trace.guard_violations')
    expect(guardrail?.status).toBe('fail')
    expect(verdict.reasons.join('; ')).toContain('trace.guard_violations')
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

  it('is inconclusive when the repetition limit is exceeded', () => {
    const verdict = evaluate({
      repetitions: { requested: 2, attempts: 3, completed: 3 },
    })
    expect(verdict.status).toBe('inconclusive')
    expect(verdict.reasons.join('; ')).toContain('exceeding the pre-registered limit')
  })

  it('is inconclusive when the failure-rate limit is exceeded', () => {
    const verdict = evaluate({
      repetitions: { requested: 2, attempts: 2, completed: 1 },
    })
    expect(verdict.status).toBe('inconclusive')
    expect(verdict.reasons.join('; ')).toContain('failure rate')
  })

  it('is inconclusive when no repetition completed', () => {
    const verdict = evaluate({
      repetitions: { requested: 2, attempts: 2, completed: 0 },
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
      invariant.id === 'trace.guard_clean' ? { ...invariant, ok: false } : invariant,
    )

    const verdict = evaluate({ invariants })
    expect(verdict.status).toBe('rejected')
    expect(verdict.reasons.join('; ')).toContain('trace.guard_clean')
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
      repetitions: goodCounts,
      invariants: unbaselined.invariants.map((id) => ({ id, ok: true })),
      providerOutages: 0,
    })

    expect(verdict.status).toBe('inconclusive')
    expect(verdict.target.status).toBe('inconclusive')
    expect(verdict.target.reason).toContain('no pre-registered baseline')
  })
})
