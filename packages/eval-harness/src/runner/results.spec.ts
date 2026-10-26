import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { manifestHash } from './manifest.js'
import { metricReadingsSchema, parseRunResult, transcriptRelativePath } from './results.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const baselinePath = join(repoRoot, 'evals/baselines/m0-canned-replay.json')

function loadCommittedBaseline(): unknown {
  return JSON.parse(readFileSync(baselinePath, 'utf8')) as unknown
}

describe('run result artifact', () => {
  it('accepts the committed baseline artifact read-only', () => {
    const result = parseRunResult(loadCommittedBaseline())

    expect(result.runId).toBe('m0-canned-replay')
    expect(result.verdict.status).toBe('accepted')
    expect(result.manifestHash).toBe(manifestHash(result.manifest))
    expect(result.transcripts).toHaveLength(12)
    expect(result.versions.seed).toBe(result.manifest.seeds.master)
    expect(result).not.toHaveProperty('score')
  })

  it('rejects an artifact whose embedded manifest was altered', () => {
    const raw = loadCommittedBaseline() as Record<string, unknown>
    raw['manifestHash'] = '0'.repeat(64)

    expect(() => parseRunResult(raw)).toThrow(/manifestHash/)
  })

  it('rejects an artifact whose verdict no longer matches its metrics', () => {
    const raw = loadCommittedBaseline() as Record<string, unknown>
    const metrics = raw['metrics'] as Record<string, number>
    metrics['replay.deterministic_rate'] = 0.5

    expect(() => parseRunResult(raw)).toThrow(/verdict/)
  })

  it('rejects an artifact whose provider-outage count does not match its trials', () => {
    const raw = loadCommittedBaseline() as Record<string, unknown>
    const verdict = raw['verdict'] as Record<string, unknown>
    verdict['providerOutages'] = 1

    expect(() => parseRunResult(raw)).toThrow(/providerOutages|provider outage/)
  })

  it('requires at least one per-axis metric', () => {
    expect(metricReadingsSchema.safeParse({}).success).toBe(false)
    expect(metricReadingsSchema.safeParse({ 'transcript.guard_violations': 0 }).success).toBe(true)
  })

  it('keeps transcript paths inside the run directory', () => {
    expect(transcriptRelativePath(0, 'en', 'en-b1-report-deadline-001')).toBe(
      'transcripts/round-0/en/en-b1-report-deadline-001.jsonl',
    )
    expect(transcriptRelativePath(1, 'fr', '../escape/id')).toBe(
      'transcripts/round-1/fr/.._escape_id.jsonl',
    )
  })
})
