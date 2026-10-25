import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { manifestHash } from './manifest.js'
import { metricReadingsSchema, parseRunResult, traceRelativePath } from './results.js'

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
    expect(result.traces).toHaveLength(12)
    expect(result.versions.seed).toBe(result.manifest.seeds.master)
    expect(result).not.toHaveProperty('score')
  })

  it('rejects an artifact whose embedded manifest was altered', () => {
    const raw = loadCommittedBaseline() as Record<string, unknown>
    raw['manifestHash'] = '0'.repeat(64)

    expect(() => parseRunResult(raw)).toThrow(/manifestHash/)
  })

  it('requires at least one per-axis metric', () => {
    expect(metricReadingsSchema.safeParse({}).success).toBe(false)
    expect(metricReadingsSchema.safeParse({ 'trace.guard_violations': 0 }).success).toBe(true)
  })

  it('keeps trace paths inside the run directory', () => {
    expect(traceRelativePath(0, 'en', 'en-b1-report-deadline-001')).toBe(
      'traces/rep-0/en/en-b1-report-deadline-001.jsonl',
    )
    expect(traceRelativePath(1, 'fr', '../escape/id')).toBe('traces/rep-1/fr/.._escape_id.jsonl')
  })
})
