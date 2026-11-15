import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { compareRunResults } from './compare.js'
import { manifestHash } from './manifest.js'
import { parseRunResult, type RunResult } from './results.js'
import { computeVerdict } from './verdict.js'
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
  draft.verdict = computeVerdict({
    manifest: draft.manifest,
    metrics: draft.metrics,
    rounds: {
      requested: draft.summary.requestedRounds,
      attempts: draft.summary.attempts,
      completed: draft.summary.completed,
    },
    invariants: draft.invariants,
    providerOutages: draft.trials.filter((trial) => trial.providerOutage).length,
  })
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
      draft.metrics['transcript.guard_violations'] = 3
    })

    const comparison = compareRunResults(baseline(), candidate)
    expect(comparison.ok).toBe(false)

    const guardrail = comparison.guardrails.find(
      (axis) => axis.metric === 'transcript.guard_violations',
    )
    expect(guardrail?.status).toBe('fail')
    expect(guardrail?.delta).toBe(3)
    expect(comparison.target.status).toBe('pass')
    expect(comparison.reasons.join('; ')).toContain('transcript.guard_violations')
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

  it('fails when the candidate is not accepted', () => {
    const candidate = cloneWith(baseline(), (draft) => {
      ;(draft.invariants[0] as { ok: boolean }).ok = false
    })

    const comparison = compareRunResults(baseline(), candidate)
    expect(comparison.ok).toBe(false)
    expect(comparison.reasons.join('; ')).toContain('only an accepted candidate')
  })

  it('is inconclusive below the minimum detectable effect', () => {
    const setMde = (draft: RunResult): void => {
      draft.manifest.run.purpose = 'capability'
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

  it('is incompatible when the grader/rubric version changed', () => {
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
      delete draft.metrics['transcript.guard_violations']
    })

    const comparison = compareRunResults(baseline(), candidate)
    expect(comparison.ok).toBe(false)
    const guardrail = comparison.guardrails.find(
      (axis) => axis.metric === 'transcript.guard_violations',
    )
    expect(guardrail?.status).toBe('inconclusive')
    expect(guardrail?.reason).toBe('guardrail "transcript.guard_violations" was not measured')
    expect(comparison.reasons).toContain('guardrail "transcript.guard_violations" was not measured')
  })
})

describe('comparison record', () => {
  it('reports the exact per-axis record when nothing changed', () => {
    const result = baseline()
    const comparison = compareRunResults(result, result)

    expect(comparison.reasons).toStrictEqual([])
    expect(comparison.compatible).toBe(true)
    expect(comparison.ok).toBe(true)
    expect(comparison.target).toStrictEqual({
      kind: 'target',
      metric: 'replay.deterministic_rate',
      direction: 'increase',
      baseline: result.metrics['replay.deterministic_rate'],
      value: result.metrics['replay.deterministic_rate'],
      delta: 0,
      improvement: 0,
      required: 0,
      status: 'pass',
      reason: 'regression axis "replay.deterministic_rate" held',
    })
    expect(
      comparison.guardrails.map(({ kind, metric, direction, delta, required, status, reason }) => ({
        kind,
        metric,
        direction,
        delta,
        required,
        status,
        reason,
      })),
    ).toStrictEqual([
      {
        kind: 'guardrail',
        metric: 'transcript.schema_valid_rate',
        direction: 'increase',
        delta: 0,
        required: 0,
        status: 'pass',
        reason: 'guardrail "transcript.schema_valid_rate" held',
      },
      {
        kind: 'guardrail',
        metric: 'transcript.content_class_rate',
        direction: 'increase',
        delta: 0,
        required: 0,
        status: 'pass',
        reason: 'guardrail "transcript.content_class_rate" held',
      },
      {
        kind: 'guardrail',
        metric: 'transcript.guard_violations',
        direction: 'decrease',
        delta: 0,
        required: 0,
        status: 'pass',
        reason: 'guardrail "transcript.guard_violations" held',
      },
      {
        kind: 'guardrail',
        metric: 'run.failure_rate',
        direction: 'decrease',
        delta: 0,
        required: 0,
        status: 'pass',
        reason: 'guardrail "run.failure_rate" held',
      },
    ])
  })

  it('evaluates the target with the capability rule when the baseline is a capability eval', () => {
    const capability = cloneWith(baseline(), (draft) => {
      draft.manifest.run.purpose = 'capability'
      draft.manifest.target.minimumDetectableEffect = 0.1
    })

    const comparison = compareRunResults(capability, capability)

    expect(comparison.compatible).toBe(true)
    expect(comparison.ok).toBe(false)
    expect(comparison.target).toStrictEqual({
      kind: 'target',
      metric: 'replay.deterministic_rate',
      direction: 'increase',
      baseline: 1,
      value: 1,
      delta: 0,
      improvement: 0,
      required: 0.1,
      status: 'inconclusive',
      reason:
        'target metric "replay.deterministic_rate" improved by 0, below the registered minimum detectable effect 0.1',
    })
    expect(comparison.reasons).toStrictEqual([
      'candidate m0-canned-replay has verdict "inconclusive"; only an accepted candidate may be compared',
      comparison.target.reason,
    ])
  })

  it('passes a capability target that clears the minimum detectable effect', () => {
    const capability = cloneWith(baseline(), (draft) => {
      draft.manifest.run.purpose = 'capability'
      draft.manifest.target.minimumDetectableEffect = 0.1
    })
    const candidate = cloneWith(capability, (draft) => {
      draft.metrics['replay.deterministic_rate'] = 1.2
    })

    const comparison = compareRunResults(capability, candidate)

    expect(comparison.compatible).toBe(true)
    expect(comparison.ok).toBe(true)
    expect(comparison.target.status).toBe('pass')
    expect(comparison.target.delta).toBeCloseTo(0.2)
    expect(comparison.target.improvement).toBeCloseTo(0.2)
    expect(comparison.target.reason).toBe(
      'target metric "replay.deterministic_rate" improved by 0.2 (required 0.1)',
    )
    expect(comparison.reasons).toStrictEqual([])
  })

  it('uses the candidate purpose, not the baseline purpose, to pick the target rule', () => {
    const capabilityBaseline = cloneWith(baseline(), (draft) => {
      draft.manifest.run.purpose = 'capability'
      draft.manifest.target.minimumDetectableEffect = 0.1
    })

    const comparison = compareRunResults(capabilityBaseline, baseline())

    expect(comparison.compatible).toBe(false)
    expect(comparison.reasons[0]).toBe(
      'eval purpose differs from the baseline; changing the eval definition invalidates the comparison',
    )
    expect(comparison.target.reason).toBe('regression axis "replay.deterministic_rate" held')
  })

  it('reports the exact target fail record and reason', () => {
    const candidate = cloneWith(baseline(), (draft) => {
      draft.metrics['replay.deterministic_rate'] = 0.5
    })

    const comparison = compareRunResults(baseline(), candidate)

    expect(comparison.reasons).toContain(
      'regression axis "replay.deterministic_rate" regressed by 0.5',
    )
  })

  it('fails when the candidate regresses against the comparison baseline yet is accepted against its own reference', () => {
    const comparisonBaseline = cloneWith(baseline(), (draft) => {
      draft.metrics['replay.deterministic_rate'] = 1.2
    })

    const comparison = compareRunResults(comparisonBaseline, baseline())

    expect(comparison.compatible).toBe(true)
    expect(comparison.target.status).toBe('fail')
    expect(comparison.reasons).toStrictEqual([
      'regression axis "replay.deterministic_rate" regressed by 0.2',
    ])
    expect(comparison.ok).toBe(false)
  })

  it('fails on a guardrail regression even when every other guardrail and the target hold', () => {
    const candidate = cloneWith(baseline(), (draft) => {
      const reference = draft.manifest.baseline
      if (reference === undefined) throw new Error('expected a registered baseline')
      reference.metrics['transcript.guard_violations'] = 1
      draft.metrics['transcript.guard_violations'] = 1
    })

    const comparison = compareRunResults(baseline(), candidate)

    expect(candidate.verdict.status).toBe('accepted')
    expect(comparison.compatible).toBe(true)
    expect(comparison.target.status).toBe('pass')
    expect(comparison.guardrails.filter((axis) => axis.status === 'pass')).toHaveLength(3)
    expect(comparison.reasons).toStrictEqual([
      'guardrail "transcript.guard_violations" regressed by 1, beyond the tolerated 0',
    ])
    expect(comparison.ok).toBe(false)
  })

  it('reports the exact inconclusive target reason below the minimum detectable effect', () => {
    const setMde = (draft: RunResult): void => {
      draft.manifest.run.purpose = 'capability'
      draft.manifest.target.minimumDetectableEffect = 0.2
    }

    const baselineResult = cloneWith(baseline(), setMde)
    const candidate = cloneWith(baseline(), (draft) => {
      setMde(draft)
      draft.metrics['replay.deterministic_rate'] = 1.05
    })

    const comparison = compareRunResults(baselineResult, candidate)

    expect(comparison.target.reason).toBe(
      'target metric "replay.deterministic_rate" improved by 0.05, below the registered minimum detectable effect 0.2',
    )
    expect(comparison.reasons).toContain(comparison.target.reason)
    expect(comparison.ok).toBe(false)
  })

  it('reports an unmeasured target as inconclusive and includes its reason', () => {
    const candidate = cloneWith(baseline(), (draft) => {
      delete draft.metrics['replay.deterministic_rate']
    })

    const comparison = compareRunResults(baseline(), candidate)

    expect(comparison.target).toStrictEqual({
      kind: 'target',
      metric: 'replay.deterministic_rate',
      direction: 'increase',
      baseline: 1,
      required: 0,
      status: 'inconclusive',
      reason: 'regression axis "replay.deterministic_rate" was not measured',
    })
    expect(comparison.reasons).toContain(
      'regression axis "replay.deterministic_rate" was not measured',
    )
    expect(comparison.ok).toBe(false)
  })

  it('reports each axis separately and never folds them into one score', () => {
    const candidate = cloneWith(baseline(), (draft) => {
      draft.metrics['transcript.guard_violations'] = 2
      draft.metrics['replay.deterministic_rate'] = 0.5
    })

    const comparison = compareRunResults(baseline(), candidate)
    const guardrail = comparison.guardrails.find(
      (axis) => axis.metric === 'transcript.guard_violations',
    )

    expect(guardrail?.delta).toBe(2)
    expect(guardrail?.direction).toBe('decrease')
    expect(guardrail?.status).toBe('fail')
    expect(comparison.target.status).toBe('fail')
    expect(comparison).not.toHaveProperty('score')
    expect(comparison.reasons).toContain(
      'regression axis "replay.deterministic_rate" regressed by 0.5',
    )
    expect(comparison.reasons).toContain(
      'guardrail "transcript.guard_violations" regressed by 2, beyond the tolerated 0',
    )
    expect(comparison.ok).toBe(false)
  })
})

describe('eval definition compatibility', () => {
  const cases: readonly {
    readonly label: string
    readonly mutate: (draft: RunResult) => void
  }[] = [
    {
      label: 'eval purpose',
      mutate: (draft) => {
        draft.manifest.run.purpose = 'capability'
        draft.manifest.target.minimumDetectableEffect = 0.5
      },
    },
    {
      label: 'task selection',
      mutate: (draft) => {
        draft.manifest.tasks.version = 'v2'
      },
    },
    {
      label: 'target registration',
      mutate: (draft) => {
        draft.manifest.target.direction = 'decrease'
      },
    },
    {
      label: 'guardrail registration',
      mutate: (draft) => {
        const first = draft.manifest.guardrails[0]
        if (first !== undefined) first.tolerance = 0.5
      },
    },
    {
      label: 'limit registration',
      mutate: (draft) => {
        draft.manifest.limits.maxFailureRate = 0.5
      },
    },
    {
      label: 'transcript checks',
      mutate: (draft) => {
        draft.manifest.invariants = ['transcript.schema_valid']
      },
    },
    {
      label: 'seed registration',
      mutate: (draft) => {
        draft.manifest.seeds.master = 1
      },
    },
    {
      label: 'provider registration',
      mutate: (draft) => {
        draft.manifest.provider.label = 'other-provider'
      },
    },
  ]

  it.each(cases)(
    'marks a changed $label as incompatible with an exact reason',
    ({ label, mutate }) => {
      const candidate = cloneWith(baseline(), mutate)

      const comparison = compareRunResults(baseline(), candidate)

      expect(comparison.compatible).toBe(false)
      expect(comparison.ok).toBe(false)
      expect(comparison.reasons[0]).toBe(
        `${label} differs from the baseline; changing the eval definition invalidates the comparison`,
      )
    },
  )

  it('reports only the definition reason for a single registration change', () => {
    const candidate = cloneWith(baseline(), (draft) => {
      draft.manifest.tasks.version = 'v2'
    })

    const comparison = compareRunResults(baseline(), candidate)

    expect(comparison.reasons).toStrictEqual([
      'task selection differs from the baseline; changing the eval definition invalidates the comparison',
    ])
  })
})

describe('version compatibility', () => {
  const cases: readonly {
    readonly label: string
    readonly key: keyof RunResult['versions']
    readonly value: string
  }[] = [
    { label: 'transcript schema version', key: 'transcriptSchemaVersion', value: '9.0.0' },
    { label: 'task dataset', key: 'taskDataset', value: 'other-dataset' },
    { label: 'task version', key: 'taskVersion', value: 'v9' },
    { label: 'grader id', key: 'graderId', value: 'other-grader' },
    { label: 'grader kind', key: 'graderKind', value: 'human' },
    { label: 'grader version', key: 'graderVersion', value: '9.0.0' },
    { label: 'grader model', key: 'graderModel', value: 'typesafe/jev-1.14' },
    { label: 'rubric version', key: 'rubricVersion', value: 'm0-harness-v2' },
  ]

  it.each(cases)(
    'marks a changed $label as incompatible with an exact reason',
    ({ label, key, value }) => {
      const candidate = cloneWith(baseline(), (draft) => {
        const versions = draft.versions as unknown as Record<string, string>
        versions[key] = value
      })
      const before = baseline().versions[key]

      const comparison = compareRunResults(baseline(), candidate)

      expect(comparison.compatible).toBe(false)
      expect(comparison.ok).toBe(false)
      expect(comparison.reasons).toStrictEqual([
        `${label} changed (baseline ${String(before ?? 'none')}, candidate ${value}); re-calibrate and re-baseline instead of comparing across versions`,
      ])
    },
  )

  it('names a missing baseline version as none', () => {
    const comparison = compareRunResults(
      baseline(),
      cloneWith(baseline(), (draft) => {
        draft.versions.graderModel = 'typesafe/jev-1.14'
      }),
    )

    expect(comparison.reasons).toStrictEqual([
      'grader model changed (baseline none, candidate typesafe/jev-1.14); re-calibrate and re-baseline instead of comparing across versions',
    ])
  })

  it('names a missing candidate version as none', () => {
    const withModel = cloneWith(baseline(), (draft) => {
      draft.versions.graderModel = 'typesafe/jev-1.14'
    })

    const comparison = compareRunResults(withModel, baseline())

    expect(comparison.reasons).toStrictEqual([
      'grader model changed (baseline typesafe/jev-1.14, candidate none); re-calibrate and re-baseline instead of comparing across versions',
    ])
  })
})

describe('candidate audit', () => {
  it('rejects a candidate that recorded a provider outage', () => {
    const candidate = cloneWith(baseline(), (draft) => {
      const first = draft.trials[0]
      if (first === undefined) throw new Error('expected at least one trial')
      first.ok = false
      first.providerOutage = true
      first.error = 'provider down'
      draft.summary.failedTrials = draft.trials.filter((trial) => !trial.ok).length
      draft.summary.failed = 1
      draft.summary.completed = draft.summary.attempts - draft.summary.failed
      draft.summary.failureRate =
        draft.summary.attempts === 0 ? 1 : draft.summary.failed / draft.summary.attempts
    })

    const comparison = compareRunResults(baseline(), candidate)

    expect(comparison.compatible).toBe(true)
    expect(candidate.verdict.status).toBe('infrastructure_inconclusive')
    expect(comparison.reasons).toStrictEqual([
      'candidate m0-canned-replay has verdict "infrastructure_inconclusive"; only an accepted candidate may be compared',
      'candidate m0-canned-replay recorded 1 provider outage(s); a failed model call is not a pass',
    ])
    expect(comparison.ok).toBe(false)
  })

  it('rejects a candidate whose transcript checks failed, in both records', () => {
    const candidate = cloneWith(baseline(), (draft) => {
      const invariant = draft.invariants.find((entry) => entry.id === 'transcript.schema_valid')
      if (invariant === undefined) throw new Error('expected the schema invariant')
      invariant.ok = false
    })

    const comparison = compareRunResults(baseline(), candidate)

    expect(candidate.verdict.status).toBe('rejected')
    expect(comparison.reasons).toStrictEqual([
      'candidate m0-canned-replay has verdict "rejected"; only an accepted candidate may be compared',
      'candidate m0-canned-replay failed transcript check(s): transcript.schema_valid',
      'candidate m0-canned-replay verdict records failed transcript check(s): transcript.schema_valid',
    ])
    expect(comparison.ok).toBe(false)
  })

  it('keeps compatibility independent of the candidate verdict', () => {
    const rejected = cloneWith(baseline(), (draft) => {
      const invariant = draft.invariants[0]
      if (invariant === undefined) throw new Error('expected an invariant')
      invariant.ok = false
    })

    const comparison = compareRunResults(baseline(), rejected)

    expect(comparison.compatible).toBe(true)
    expect(comparison.target.status).toBe('pass')
    expect(comparison.guardrails.every((axis) => axis.status === 'pass')).toBe(true)
    expect(comparison.ok).toBe(false)
  })

  it('lists every failed transcript check in both records', () => {
    const candidate = cloneWith(baseline(), (draft) => {
      const failing = new Set(['transcript.schema_valid', 'transcript.seq_monotonic'])
      for (const invariant of draft.invariants) {
        if (failing.has(invariant.id)) invariant.ok = false
      }
    })

    const comparison = compareRunResults(baseline(), candidate)

    expect(comparison.reasons).toStrictEqual([
      'candidate m0-canned-replay has verdict "rejected"; only an accepted candidate may be compared',
      'candidate m0-canned-replay failed transcript check(s): transcript.schema_valid, transcript.seq_monotonic',
      'candidate m0-canned-replay verdict records failed transcript check(s): transcript.schema_valid, transcript.seq_monotonic',
    ])
    expect(comparison.ok).toBe(false)
  })
})
