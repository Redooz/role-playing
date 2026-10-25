import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { compareRunResults } from './compare.js'
import { manifestHash } from './manifest.js'
import { parseRunResult, type RunResult } from './results.js'
import { executeRun } from './runner.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const manifestPath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')

function loadManifestRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
}

function cloneWith(base: RunResult, mutate: (draft: RunResult) => void): RunResult {
  const draft = structuredClone(base)
  mutate(draft)
  draft.manifestHash = manifestHash(draft.manifest)
  return parseRunResult(draft)
}

let base: RunResult | undefined

beforeAll(async () => {
  base = (
    await executeRun({
      repoRoot,
      manifest: loadManifestRaw(),
      wallClock: () => 1_700_000_000_000,
    })
  ).result
})

function baseline(): RunResult {
  if (base === undefined) throw new Error('baseline was not executed')
  return base
}

describe('baseline comparison', () => {
  it('reports per-axis deltas with no composite score when nothing changed', () => {
    const comparison = compareRunResults(baseline(), baseline())

    expect(comparison.ok).toBe(true)
    expect(comparison.compatible).toBe(true)
    expect(comparison.target.delta).toBe(0)
    expect(comparison.target.status).toBe('pass')
    expect(comparison.guardrails).toHaveLength(baseline().manifest.guardrails.length)
    expect(comparison.guardrails.every((guardrail) => guardrail.status === 'pass')).toBe(true)
    expect(comparison).not.toHaveProperty('score')
  })

  it('fails when a guardrail regresses, even if the target improves', () => {
    const candidate = cloneWith(baseline(), (draft) => {
      draft.metrics['replay.deterministic_rate'] = 2
      draft.metrics['trace.guard_violations'] = 3
    })

    const comparison = compareRunResults(baseline(), candidate)
    expect(comparison.ok).toBe(false)

    const guardrail = comparison.guardrails.find((axis) => axis.metric === 'trace.guard_violations')
    expect(guardrail?.status).toBe('fail')
    expect(guardrail?.delta).toBe(3)
    expect(comparison.target.status).toBe('pass')
    expect(comparison.reasons.join('; ')).toContain('trace.guard_violations')
  })

  it('fails when the target regresses', () => {
    const candidate = cloneWith(baseline(), (draft) => {
      draft.metrics['replay.deterministic_rate'] = 0.5
    })

    const comparison = compareRunResults(baseline(), candidate)
    expect(comparison.ok).toBe(false)
    expect(comparison.target.status).toBe('fail')
    expect(comparison.target.delta).toBe(-0.5)
  })

  it('is inconclusive below the minimum detectable effect', () => {
    const setMde = (draft: RunResult): void => {
      draft.manifest.target.minimumDetectableEffect = 0.2
    }

    const baselineResult = cloneWith(baseline(), setMde)
    const candidate = cloneWith(baseline(), (draft) => {
      setMde(draft)
      draft.metrics['replay.deterministic_rate'] = 1.05
    })

    const comparison = compareRunResults(baselineResult, candidate)
    expect(comparison.compatible).toBe(true)
    expect(comparison.target.status).toBe('inconclusive')
    expect(comparison.ok).toBe(false)
  })

  it('is incompatible when the scorer/rubric version changed', () => {
    const candidate = cloneWith(baseline(), (draft) => {
      draft.versions.rubricVersion = 'm0-harness-v2'
    })

    const comparison = compareRunResults(baseline(), candidate)
    expect(comparison.compatible).toBe(false)
    expect(comparison.ok).toBe(false)
    expect(comparison.reasons.join('; ')).toContain('rubric version')
  })

  it('is incompatible when a guardrail registration is widened', () => {
    const candidate = cloneWith(baseline(), (draft) => {
      const first = draft.manifest.guardrails[0]
      if (first !== undefined) first.tolerance = 0.5
    })

    const comparison = compareRunResults(baseline(), candidate)
    expect(comparison.compatible).toBe(false)
    expect(comparison.ok).toBe(false)
    expect(comparison.reasons.join('; ')).toContain('guardrail registration')
  })

  it('treats a missing axis as inconclusive, never as a pass', () => {
    const candidate = cloneWith(baseline(), (draft) => {
      delete draft.metrics['trace.guard_violations']
    })

    const comparison = compareRunResults(baseline(), candidate)
    expect(comparison.ok).toBe(false)
    const guardrail = comparison.guardrails.find((axis) => axis.metric === 'trace.guard_violations')
    expect(guardrail?.status).toBe('inconclusive')
  })
})
