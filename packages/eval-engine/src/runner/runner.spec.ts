import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, sha256Hex } from '@rp/shared'
import { describe, expect, it } from 'vitest'
import { ManifestValidationError, manifestHash, parseManifest } from './manifest.js'
import { executeRun } from './runner.js'
import type { RunScorer } from './scorer.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const manifestPath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')

function loadManifestRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
}

const fixedWallClock = (): number => 1_700_000_000_000

describe('executeRun (gate G1)', () => {
  it('runs the committed EN/FR manifest twice with byte-identical normalized traces', async () => {
    const raw = loadManifestRaw()

    const first = await executeRun({ repoRoot, manifest: raw, wallClock: fixedWallClock })
    const second = await executeRun({ repoRoot, manifest: raw, wallClock: fixedWallClock })

    const firstTraces = new Map(
      first.traces.map((trace) => [
        `${trace.repetition}\u0000${trace.lang}\u0000${trace.fixtureId}`,
        trace,
      ]),
    )
    const secondTraces = new Map(
      second.traces.map((trace) => [
        `${trace.repetition}\u0000${trace.lang}\u0000${trace.fixtureId}`,
        trace,
      ]),
    )

    expect(firstTraces.size).toBe(12)
    expect([...secondTraces.keys()].sort()).toEqual([...firstTraces.keys()].sort())

    for (const [key, firstTrace] of firstTraces) {
      const secondTrace = secondTraces.get(key)
      expect(secondTrace, key).toBeDefined()
      expect(secondTrace?.jsonl, key).toBe(firstTrace.jsonl)
      expect(secondTrace?.sha256, key).toBe(firstTrace.sha256)
      expect(sha256Hex(firstTrace.jsonl)).toBe(firstTrace.sha256)
    }

    // Fixtures come from both languages, not just the easy one.
    expect(new Set(first.traces.map((trace) => trace.lang))).toEqual(new Set(['en', 'fr']))
  })

  it('writes a valid accepted artifact with full version stamps and no composite score', async () => {
    const raw = loadManifestRaw()
    const manifest = parseManifest(raw)
    const execution = await executeRun({ repoRoot, manifest: raw, wallClock: fixedWallClock })
    const result = execution.result

    expect(result.verdict.status).toBe('accepted')
    expect(result.manifestHash).toBe(manifestHash(manifest))
    expect(result.manifest).toEqual(manifest)
    expect(result.schemaVersion).toBe('1.0.0')
    expect(result.repetitions).toHaveLength(12)
    expect(result.repetitions.every((outcome) => outcome.ok)).toBe(true)
    expect(result.summary).toMatchObject({
      requestedRepetitions: 2,
      attempts: 2,
      completed: 2,
      failed: 0,
      failureRate: 0,
      executions: 12,
      failedExecutions: 0,
    })

    expect(result.versions.seed).toBe(manifest.seeds.master)
    expect(result.versions.fixtureDataset).toBe(manifest.fixtures.dataset)
    expect(result.versions.fixtureVersion).toBe(manifest.fixtures.version)
    expect(result.versions.scorerId).toBe(manifest.scorer.id)
    expect(result.versions.rubricVersion).toBe(manifest.rubric.version)
    expect(result.versions.traceSchemaVersion).toBe('1.0.0')

    expect(Object.keys(result.metrics).sort()).toEqual([
      'replay.deterministic_rate',
      'run.failure_rate',
      'trace.content_class_rate',
      'trace.guard_violations',
      'trace.schema_valid_rate',
    ])
    expect(result).not.toHaveProperty('score')
    expect(result.metrics).not.toHaveProperty('score')

    expect(result.invariants.every((invariant) => invariant.ok)).toBe(true)
  })

  it('refuses a manifest without limits before doing any work', async () => {
    const raw = loadManifestRaw()
    delete raw['limits']

    await expect(
      executeRun({ repoRoot, manifest: raw, wallClock: fixedWallClock }),
    ).rejects.toBeInstanceOf(ManifestValidationError)
  })

  it('refuses a scorer that does not match the pre-registered scorer version', async () => {
    const wrongScorer: RunScorer = {
      id: 'jev',
      version: 'typesafe/jev-1.14',
      score() {
        return Promise.resolve({ 'replay.deterministic_rate': 1 })
      },
    }

    await expect(
      executeRun({
        repoRoot,
        manifest: loadManifestRaw(),
        scorer: wrongScorer,
        wallClock: fixedWallClock,
      }),
    ).rejects.toThrow(/scorer mismatch/)
  })

  it('turns a live provider outage into infrastructure_inconclusive, never a pass', async () => {
    const raw = loadManifestRaw()
    raw['provider'] = { mode: 'live', label: 'm0-live-not-wired', allowLive: true }

    const execution = await executeRun({ repoRoot, manifest: raw, wallClock: fixedWallClock })
    const result = execution.result

    expect(result.verdict.status).toBe('infrastructure_inconclusive')
    expect(result.verdict.providerOutages).toBeGreaterThan(0)
    expect(result.summary.failedExecutions).toBe(12)
    expect(result.traces).toHaveLength(0)
    expect(result.repetitions.every((outcome) => !outcome.ok && outcome.providerOutage)).toBe(true)
  })

  it('records the manifest copy canonically so its hash can be re-derived', () => {
    const manifest = parseManifest(loadManifestRaw())
    expect(sha256Hex(canonicalJson(manifest))).toBe(manifestHash(manifest))
  })
})
