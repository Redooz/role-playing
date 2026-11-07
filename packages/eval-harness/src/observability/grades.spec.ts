import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson } from '@rp/shared'
import { describe, expect, it } from 'vitest'
import { buildGrades } from './grades.js'
import { executeRun, type EvaluationRun } from '../runner/runner.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const manifestPath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')

const fixedWallClock = (): number => 1_700_000_000_000

function loadManifestRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
}

async function run(): Promise<EvaluationRun> {
  return executeRun({ repoRoot, manifest: loadManifestRaw(), wallClock: fixedWallClock })
}

describe('buildGrades', () => {
  it('writes one raw grade record per trial, for both languages', async () => {
    const execution = await run()
    const grades = buildGrades({ execution })

    expect(grades.records).toHaveLength(12)
    expect(new Set(grades.records.map((record) => record.lang))).toEqual(new Set(['en', 'fr']))
    expect(new Set(grades.records.map((record) => record.trialId)).size).toBe(12)
    expect(grades.jsonl.trimEnd().split('\n')).toHaveLength(12)

    for (const record of grades.records) {
      expect(record.schemaVersion).toBe('1.0.0')
      expect(record.executionId).toBe(grades.executionId)
      expect(record.runId).toBe('m0-canned-replay')
      expect(record.grader).toEqual({
        id: 'deterministic-invariants',
        kind: 'code',
        version: '1.0.0',
      })
      expect(record.rubricVersion).toBe('m0-harness-v1')
      expect(record.status).toBe('graded')
      expect(record.task.cefrBand).toMatch(/^[ABC][12]$/)
    }
  })

  it('stores per-axis facts and evidence, with no composite score', async () => {
    const execution = await run()
    const [record] = buildGrades({ execution }).records
    expect(record).toBeDefined()

    const metrics = record?.scores.map((score) => score.metric)
    expect(metrics).toEqual([
      'trial.status',
      'trial.ok',
      'trial.provider_outage',
      'transcript.schema_valid',
      'transcript.seq_monotonic',
      'transcript.content_class',
      'transcript.guard_violations',
      'trial.records',
      'trial.sim_duration_ms',
    ])

    expect(metrics).not.toContain('score')
    expect(metrics).not.toContain('overall')

    const guard = record?.scores.find((score) => score.metric === 'transcript.guard_violations')
    expect(guard?.kind).toBe('numeric')
    expect(guard?.value).toBe(0)
    expect(guard?.evidence).toBe('no §3.2 guard violations')

    expect(record?.scores.every((score) => score.status === 'graded')).toBe(true)
  })

  it('is byte-identical for the same run (deterministic sidecar)', async () => {
    const execution = await run()
    const first = buildGrades({ execution })
    const second = buildGrades({ execution })
    expect(second.jsonl).toBe(first.jsonl)
    expect(canonicalJson(second.records)).toBe(canonicalJson(first.records))
  })

  it('marks a provider outage inconclusive and never scores it as zero', async () => {
    const { ProviderUnavailableError } = await import('../runner/canned-provider.js')
    const execution = await executeRun({
      repoRoot,
      manifest: loadManifestRaw(),
      wallClock: fixedWallClock,
      providerFactory: () => ({
        kind: 'live',
        label: 'test-outage',
        complete() {
          throw new ProviderUnavailableError('provider is down', 'test-outage')
        },
      }),
    })

    const grades = buildGrades({ execution })

    expect(grades.records).toHaveLength(12)
    for (const record of grades.records) {
      expect(record.status).toBe('inconclusive')
      expect(record.scores.map((score) => score.metric).sort()).toEqual([
        'trial.ok',
        'trial.provider_outage',
        'trial.status',
      ])
      const status = record.scores.find((score) => score.metric === 'trial.status')
      expect(status?.value).toBe('inconclusive')
      expect(status?.status).toBe('inconclusive')
      expect(record.scores.some((score) => score.metric.startsWith('transcript.'))).toBe(false)
      expect(record.error).toContain('provider is down')
    }
  })
})
