import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, sha256Hex } from '@rp/shared'
import { TRANSCRIPT_SCHEMA_VERSION } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import { ManifestValidationError, manifestHash, parseManifest } from './manifest.js'
import { executeRun, loadSelectedTasks } from './runner.js'
import type { Grader } from './grader.js'
import { buildCannedEntriesForTask } from './replay.js'
import {
  createCannedProvider,
  type CompletionChunk,
  type CompletionProvider,
} from './canned-provider.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const manifestPath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')

function loadManifestRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
}

const fixedWallClock = (): number => 1_700_000_000_000

/** An async stream whose first read rejects, so a trial fails at the provider. */
function failingStream(message: string): AsyncIterable<CompletionChunk> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return Promise.reject(new Error(message))
        },
      }
    },
  }
}

describe('executeRun (gate G1)', () => {
  it('runs the committed EN/FR manifest twice with byte-identical normalized transcripts', async () => {
    const raw = loadManifestRaw()

    const first = await executeRun({ repoRoot, manifest: raw, wallClock: fixedWallClock })
    const second = await executeRun({ repoRoot, manifest: raw, wallClock: fixedWallClock })

    const firstTranscripts = new Map(
      first.transcripts.map((transcript) => [
        `${transcript.round}\u0000${transcript.lang}\u0000${transcript.taskId}`,
        transcript,
      ]),
    )
    const secondTranscripts = new Map(
      second.transcripts.map((transcript) => [
        `${transcript.round}\u0000${transcript.lang}\u0000${transcript.taskId}`,
        transcript,
      ]),
    )

    expect(firstTranscripts.size).toBe(12)
    expect([...secondTranscripts.keys()].sort()).toEqual([...firstTranscripts.keys()].sort())

    for (const [key, firstTranscript] of firstTranscripts) {
      const secondTranscript = secondTranscripts.get(key)
      expect(secondTranscript, key).toBeDefined()
      expect(secondTranscript?.jsonl, key).toBe(firstTranscript.jsonl)
      expect(secondTranscript?.sha256, key).toBe(firstTranscript.sha256)
      expect(sha256Hex(firstTranscript.jsonl)).toBe(firstTranscript.sha256)
    }

    // Tasks come from both languages, not just the easy one.
    expect(new Set(first.transcripts.map((transcript) => transcript.lang))).toEqual(
      new Set(['en', 'fr']),
    )

    // One execution identity for the whole run, distinct from the suite id.
    const executionIds = new Set(
      first.transcripts.flatMap((transcript) =>
        transcript.records.map((record) => record.executionId),
      ),
    )
    expect(executionIds.size).toBe(1)
    expect([...executionIds][0]).not.toBe(first.result.runId)
  })

  it('writes a valid accepted artifact with full version stamps and no composite score', async () => {
    const raw = loadManifestRaw()
    const manifest = parseManifest(raw)
    const execution = await executeRun({ repoRoot, manifest: raw, wallClock: fixedWallClock })
    const result = execution.result

    expect(result.verdict.status).toBe('accepted')
    expect(result.manifestHash).toBe(manifestHash(manifest))
    expect(result.manifest).toEqual(manifest)
    expect(result.schemaVersion).toBe('3.0.0')
    expect(result.trials).toHaveLength(12)
    expect(result.trials.every((outcome) => outcome.ok)).toBe(true)
    expect(result.summary).toMatchObject({
      requestedRounds: 2,
      attempts: 2,
      completed: 2,
      failed: 0,
      failureRate: 0,
      trials: 12,
      failedTrials: 0,
    })

    expect(result.versions.seed).toBe(manifest.seeds.master)
    expect(result.versions.taskDataset).toBe(manifest.tasks.dataset)
    expect(result.versions.taskVersion).toBe(manifest.tasks.version)
    expect(result.versions.graderId).toBe(manifest.grader.id)
    expect(result.versions.rubricVersion).toBe(manifest.rubric.version)
    expect(result.versions.transcriptSchemaVersion).toBe(TRANSCRIPT_SCHEMA_VERSION)

    expect(Object.keys(result.metrics).sort()).toEqual([
      'replay.deterministic_rate',
      'response.emoji_count',
      'response.markdown_count',
      'response.plain_text_rate',
      'run.failure_rate',
      'transcript.content_class_rate',
      'transcript.guard_violations',
      'transcript.schema_valid_rate',
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

  it('refuses a grader that does not match the pre-registered grader version', async () => {
    const wrongGrader: Grader = {
      id: 'jev',
      kind: 'system-one-model',
      version: 'typesafe/jev-1.14',
      score() {
        return Promise.resolve({ 'replay.deterministic_rate': 1 })
      },
    }

    await expect(
      executeRun({
        repoRoot,
        manifest: loadManifestRaw(),
        grader: wrongGrader,
        wallClock: fixedWallClock,
      }),
    ).rejects.toThrow(/grader mismatch/)
  })

  it('turns a live provider outage into infrastructure_inconclusive, never a pass', async () => {
    const raw = loadManifestRaw()
    raw['provider'] = { mode: 'live', label: 'm0-live-not-wired', allowLive: true }

    const execution = await executeRun({ repoRoot, manifest: raw, wallClock: fixedWallClock })
    const result = execution.result

    expect(result.verdict.status).toBe('infrastructure_inconclusive')
    expect(result.verdict.providerOutages).toBeGreaterThan(0)
    expect(result.summary.failedTrials).toBe(12)
    expect(result.transcripts).toHaveLength(0)
    expect(result.trials.every((outcome) => !outcome.ok && outcome.providerOutage)).toBe(true)
  })

  it('gives every trial a fresh provider and disposes it, so one failure cannot poison the next', async () => {
    const raw = loadManifestRaw()
    const manifest = parseManifest(raw)
    const tasks = await loadSelectedTasks(repoRoot, manifest.tasks)
    const firstTask = tasks[0]
    if (firstTask === undefined) throw new Error('the manifest selected no tasks')

    const entries = tasks.flatMap(({ task }) => buildCannedEntriesForTask(task))
    const base = createCannedProvider(entries, 'isolation-base')
    const failingTaskId = firstTask.task.id
    let created = 0
    let disposed = 0

    const providerFactory = (): CompletionProvider => {
      created += 1
      const instance = created
      return {
        kind: 'canned',
        label: `isolation-${instance}`,
        complete(request) {
          if (request.metadata?.taskId === failingTaskId) {
            return failingStream('trial boom')
          }
          return base.complete(request)
        },
        dispose() {
          disposed += 1
        },
      }
    }

    const execution = await executeRun({
      repoRoot,
      manifest: raw,
      wallClock: fixedWallClock,
      providerFactory,
    })

    const expectedTrials = manifest.limits.rounds * tasks.length
    expect(created).toBe(expectedTrials)
    expect(disposed).toBe(expectedTrials)
    expect(execution.result.trials).toHaveLength(expectedTrials)

    const failed = execution.result.trials.filter((trial) => !trial.ok)
    expect(failed).toHaveLength(manifest.limits.rounds)
    expect(failed.every((trial) => trial.taskId === failingTaskId)).toBe(true)
    expect(failed.every((trial) => trial.error?.includes('trial boom'))).toBe(true)

    // Every other task still produced exactly the transcript of a clean run.
    const clean = await executeRun({ repoRoot, manifest: raw, wallClock: fixedWallClock })
    const cleanTranscripts = new Map(
      clean.transcripts.map((transcript) => [
        `${transcript.round}\u0000${transcript.lang}\u0000${transcript.taskId}`,
        transcript.jsonl,
      ]),
    )

    for (const transcript of execution.transcripts) {
      const key = `${transcript.round}\u0000${transcript.lang}\u0000${transcript.taskId}`
      expect(transcript.jsonl, key).toBe(cleanTranscripts.get(key))
    }
  })

  it('records the manifest copy canonically so its hash can be re-derived', () => {
    const manifest = parseManifest(loadManifestRaw())
    expect(sha256Hex(canonicalJson(manifest))).toBe(manifestHash(manifest))
  })
})
