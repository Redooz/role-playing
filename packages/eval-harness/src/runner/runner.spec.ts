import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, sha256Hex } from '@rp/shared'
import { TRANSCRIPT_SCHEMA_VERSION } from '@rp/session-core'
import { describe, expect, it, vi } from 'vitest'
import { ManifestValidationError, manifestHash, parseManifest } from './manifest.js'
import { executeRun, loadSelectedTasks } from './runner.js'
import {
  createDeterministicInvariantGrader,
  type Grader,
  type SemanticGrade,
  type TrialRecord,
} from './grader.js'
import { buildCannedEntriesForTask } from './replay.js'
import {
  createCannedProvider,
  type CompletionChunk,
  type CompletionProvider,
} from './canned-provider.js'
import { HarnessConfigError } from './errors.js'
import { parseRunResult } from './results.js'
import {
  GENERIC_PROMPT_TEMPLATE_VERSION,
  SESSION_PROMPT_TEMPLATE_VERSION,
} from './session-runner.js'

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

  it('refuses a manifest whose rubric the injected grader does not implement', async () => {
    const raw = loadManifestRaw()
    raw['grader'] = {
      id: 'jev',
      kind: 'system-one-model',
      version: 'typesafe/jev-1.14',
      model: 'typesafe/jev-1.14',
    }
    raw['rubric'] = { version: 'm2-persona-rubric-v1', ids: ['m2-persona-rubric-v1'] }
    const grader: Grader = {
      id: 'jev',
      kind: 'system-one-model',
      version: 'typesafe/jev-1.14',
      rubricVersion: 'm2-persona-rubric-v2',
      score() {
        return Promise.resolve({ 'replay.deterministic_rate': 1 })
      },
    }

    await expect(
      executeRun({
        repoRoot,
        manifest: raw,
        grader,
        wallClock: fixedWallClock,
      }),
    ).rejects.toThrow(/rubric mismatch/)
  })

  it('refuses a semantic grader that declares no rubric', async () => {
    const raw = loadManifestRaw()
    raw['grader'] = {
      id: 'jev',
      kind: 'system-one-model',
      version: 'typesafe/jev-1.14',
      model: 'typesafe/jev-1.14',
    }
    raw['rubric'] = { version: 'm2-persona-rubric-v2', ids: ['m2-persona-rubric-v2'] }
    const grader: Grader = {
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
        manifest: raw,
        grader,
        wallClock: fixedWallClock,
      }),
    ).rejects.toThrow(/declares no rubric/)
  })

  it('accepts a semantic manifest whose rubric the grader declares', async () => {
    const raw = loadManifestRaw()
    raw['grader'] = {
      id: 'jev',
      kind: 'system-one-model',
      version: 'typesafe/jev-1.14',
      model: 'typesafe/jev-1.14',
    }
    raw['rubric'] = { version: 'm2-persona-rubric-v2', ids: ['m2-persona-rubric-v2'] }
    const invariants = createDeterministicInvariantGrader()
    const grader: Grader = {
      ...invariants,
      id: 'jev',
      kind: 'system-one-model',
      version: 'typesafe/jev-1.14',
      rubricVersion: 'm2-persona-rubric-v2',
    }

    const execution = await executeRun({
      repoRoot,
      manifest: raw,
      grader,
      wallClock: fixedWallClock,
    })

    expect(execution.result.verdict.status).toBe('accepted')
    expect(execution.result.versions.rubricVersion).toBe('m2-persona-rubric-v2')
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

const EN_TASKS = [
  'en-b1-report-deadline-001',
  'en-b2-decline-meeting-003',
  'en-b2-standup-clarify-002',
] as const
const GOLDEN_TASK_ID = 'en-b1-report-deadline-001'
const SESSION_TASK_ID = 'en-b1-deadline-manager-101'
const MULTI_PERSONA_TASK_ID = 'en-b2-scope-en-cal-201'
const SESSION_DATE = '2026-11-08'

function probeManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const raw = loadManifestRaw()
  return {
    ...raw,
    run: {
      ...(raw['run'] as Record<string, unknown>),
      runId: 'runner-probe',
      suite: 'runner-probe',
    },
    tasks: {
      dataset: 'synthetic-workplace',
      version: 'v1',
      languages: ['en'],
      splits: ['calibration', 'holdout'],
    },
    limits: { rounds: 1, maxFailureRate: 1 },
    ...overrides,
  }
}

function taskManifest(
  taskId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return probeManifest({
    tasks: {
      dataset: 'synthetic-workplace',
      version: 'v1',
      languages: ['en'],
      ids: [taskId],
    },
    ...extra,
  })
}

function sessionManifest(
  taskIds: readonly string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return probeManifest({
    tasks: {
      dataset: 'synthetic-workplace-session',
      version: 'v1',
      languages: ['en'],
      ids: taskIds,
    },
    prompt: { currentDate: SESSION_DATE },
    ...overrides,
  })
}

function hangingProvider(label = 'hanging'): CompletionProvider {
  return {
    kind: 'canned',
    label,
    complete() {
      return {
        [Symbol.asyncIterator]() {
          return { next: () => new Promise<never>(() => undefined) }
        },
      }
    },
    dispose() {
      return Promise.resolve()
    },
  }
}

/** Streams a fixed reply, records every request and counts disposals. */
function recordingProvider(requests: string[][] = []): CompletionProvider & {
  readonly disposed: () => number
} {
  let disposals = 0
  return {
    kind: 'canned',
    label: 'recording',
    async *complete(request) {
      requests.push(request.messages.map((message) => `${message.role}:${message.content}`))
      yield { text: 'Okay.', done: false }
      yield { text: '', done: true }
    },
    dispose() {
      disposals += 1
    },
    disposed: () => disposals,
  }
}

/**
 * Run `start` while advancing fake timers, so a per-trial wall-clock budget can
 * expire without waiting for it. Only `setTimeout`/`clearTimeout` are faked so
 * file IO and `setImmediate` still make progress.
 *
 * The loop bounds **real** elapsed time, not iterations. Every real filesystem
 * await before the trial registers its budget timer would otherwise spend the
 * same fixed step budget: a cold or slow checkout can burn 2000 `setImmediate`
 * turns before the first timer exists, and the run then looks stuck even though
 * nothing is wrong. A genuine hang still fails here, before Vitest's own
 * timeout, because a step only costs microseconds.
 */
async function runWithAdvancedTime<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined
    const promise = start()
    promise.then(
      (value) => {
        outcome = { ok: true, value }
      },
      (error: unknown) => {
        outcome = { ok: false, error }
      },
    )

    const deadline = Date.now() + 3_000
    while (outcome === undefined && Date.now() < deadline) {
      // Let file IO and promise chains progress before moving simulated time.
      await new Promise((resolve) => setImmediate(resolve))
      if (vi.getTimerCount() > 0) await vi.advanceTimersByTimeAsync(1_000)
    }

    if (outcome === undefined) throw new Error('the run did not settle under advanced time')
    if (!outcome.ok) throw outcome.error
    return outcome.value
  } finally {
    vi.useRealTimers()
  }
}

describe('executeRun wall clock and version stamps', () => {
  it('stamps the run with the system clock when no wall clock is injected', async () => {
    const before = Date.now()
    const execution = await executeRun({ repoRoot, manifest: taskManifest(GOLDEN_TASK_ID) })
    const after = Date.now()

    const startedAt = Date.parse(execution.result.startedAt)
    const finishedAt = Date.parse(execution.result.finishedAt)
    expect(execution.result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
    expect(startedAt).toBeGreaterThanOrEqual(before)
    expect(startedAt).toBeLessThanOrEqual(after)
    expect(finishedAt).toBeGreaterThanOrEqual(startedAt)
  })

  it('stamps the caller-resolved code SHA and omits it when unknown', async () => {
    const withSha = await executeRun({
      repoRoot,
      manifest: taskManifest(GOLDEN_TASK_ID),
      wallClock: fixedWallClock,
      codeSha: 'a1b2c3d',
    })
    const withoutSha = await executeRun({
      repoRoot,
      manifest: taskManifest(GOLDEN_TASK_ID),
      wallClock: fixedWallClock,
    })

    expect(withSha.result.versions.codeSha).toBe('a1b2c3d')
    expect(Object.hasOwn(withoutSha.result.versions, 'codeSha')).toBe(false)
    expect(withSha.result.versions.seed).toBe(20261025)
  })

  it('parses its own artifact before returning it', async () => {
    const execution = await executeRun({
      repoRoot,
      manifest: taskManifest(GOLDEN_TASK_ID),
      wallClock: fixedWallClock,
    })

    expect(parseRunResult(execution.result)).toStrictEqual(execution.result)
    expect(execution.result.transcripts).toStrictEqual([
      {
        taskId: GOLDEN_TASK_ID,
        lang: 'en',
        round: 0,
        path: `transcripts/round-0/en/${GOLDEN_TASK_ID}.jsonl`,
        sha256: execution.transcripts[0]?.sha256,
      },
    ])
    expect(execution.transcripts[0]?.relativePath).toBe(
      `transcripts/round-0/en/${GOLDEN_TASK_ID}.jsonl`,
    )
    expect(execution.transcripts[0]?.sha256).toBe(sha256Hex(execution.transcripts[0]?.jsonl ?? ''))
    expect(execution.transcripts[0]?.records.length).toBeGreaterThan(0)
  })
})

describe('executeRun task selection', () => {
  it('shuffles tasks deterministically from the master seed, keeping the same set', async () => {
    const raw = probeManifest()
    const first = await executeRun({ repoRoot, manifest: raw, wallClock: fixedWallClock })
    const second = await executeRun({ repoRoot, manifest: raw, wallClock: fixedWallClock })
    const loaded = await loadSelectedTasks(repoRoot, parseManifest(raw).tasks)

    const loadedOrder = loaded.map((entry) => entry.task.id)
    const firstOrder = first.tasks.map((entry) => entry.task.id)
    const secondOrder = second.tasks.map((entry) => entry.task.id)

    expect(loadedOrder).toStrictEqual([...EN_TASKS].sort())
    expect([...firstOrder].sort()).toStrictEqual([...loadedOrder].sort())
    expect(firstOrder).toStrictEqual(secondOrder)
    expect(firstOrder).not.toStrictEqual(loadedOrder)
    expect(first.result.trials.map((trial) => trial.taskId)).toStrictEqual(firstOrder)
  })
})

describe('executeRun trial budget wiring', () => {
  it('gives a replay trial the 30-second default budget', async () => {
    const execution = await runWithAdvancedTime(() =>
      executeRun({
        repoRoot,
        manifest: taskManifest(GOLDEN_TASK_ID),
        wallClock: fixedWallClock,
        providerFactory: () => hangingProvider(),
      }),
    )

    expect(execution.result.trials).toHaveLength(1)
    expect(execution.result.trials[0]?.ok).toBe(false)
    expect(execution.result.trials[0]?.error).toContain('exceeded its 30000 ms timeout')
    expect(execution.result.trials[0]?.providerOutage).toBe(true)
    expect(execution.result.transcripts).toHaveLength(0)
  })

  it('gives a session trial the 180-second default budget', async () => {
    const execution = await runWithAdvancedTime(() =>
      executeRun({
        repoRoot,
        manifest: sessionManifest([SESSION_TASK_ID]),
        wallClock: fixedWallClock,
        providerFactory: () => hangingProvider(),
      }),
    )

    expect(execution.result.trials).toHaveLength(1)
    expect(execution.result.trials[0]?.error).toContain('exceeded its 180000 ms timeout')
  })

  it('honours an explicit per-trial budget', async () => {
    const execution = await runWithAdvancedTime(() =>
      executeRun({
        repoRoot,
        manifest: taskManifest(GOLDEN_TASK_ID),
        wallClock: fixedWallClock,
        providerFactory: () => hangingProvider(),
        trialTimeoutMs: 5_000,
      }),
    )

    expect(execution.result.trials[0]?.error).toContain('exceeded its 5000 ms timeout')
    expect(execution.result.trials[0]?.providerOutage).toBe(true)
  })

  it('applies the explicit budget to session tasks too', async () => {
    const execution = await runWithAdvancedTime(() =>
      executeRun({
        repoRoot,
        manifest: sessionManifest([SESSION_TASK_ID]),
        wallClock: fixedWallClock,
        providerFactory: () => hangingProvider(),
        trialTimeoutMs: 5_000,
      }),
    )

    expect(execution.result.trials[0]?.error).toContain('exceeded its 5000 ms timeout')
  })
})

describe('executeRun goldens and grader details', () => {
  it('attaches the matching golden entry and leaves other trials without one', async () => {
    const captured: TrialRecord[] = []
    const base = createDeterministicInvariantGrader()
    const grader: Grader = {
      ...base,
      async score(context) {
        captured.push(...context.trials)
        return base.score(context)
      },
    }

    await executeRun({
      repoRoot,
      manifest: probeManifest(),
      grader,
      wallClock: fixedWallClock,
    })

    const golden = captured.find((trial) => trial.taskId === GOLDEN_TASK_ID)
    if (golden === undefined) throw new Error('the golden task did not run')

    expect(Object.hasOwn(golden, 'golden')).toBe(true)
    expect(golden.golden?.id).toBe('golden-en-v1-report-deadline-001')
    expect(golden.golden?.taskId).toBe(GOLDEN_TASK_ID)
    expect(golden.golden?.lang).toBe('en')

    const withoutGolden = captured.filter((trial) => trial.taskId !== GOLDEN_TASK_ID)
    expect(withoutGolden).toHaveLength(EN_TASKS.length - 1)
    for (const trial of withoutGolden) expect(Object.hasOwn(trial, 'golden')).toBe(false)
  })

  it('returns the raw semantic details a grader produced', async () => {
    const detail: SemanticGrade = {
      trialId: `0:en:${GOLDEN_TASK_ID}`,
      axis: 'task_completion',
      metric: 'response.task_completion',
      question: 'Did the persona move the request forward?',
      probability: 0.82,
      threshold: 0.5,
      distribution: { yes: 0.82, no: 0.18 },
      servedModel: 'typesafe/jev-1.14-20261014',
      cacheHit: false,
    }
    let seenRunId: string | undefined
    let seenTrials = 0
    const base = createDeterministicInvariantGrader()
    const grader: Grader = {
      ...base,
      async details(context) {
        seenRunId = context.manifest.run.runId
        seenTrials = context.trials.length
        return [detail]
      },
    }

    const execution = await executeRun({
      repoRoot,
      manifest: taskManifest(GOLDEN_TASK_ID),
      grader,
      wallClock: fixedWallClock,
    })

    expect(execution.gradeDetails).toStrictEqual([detail])
    expect(seenRunId).toBe('runner-probe')
    expect(seenTrials).toBe(1)
  })

  it('reports no grade details for a grader that has none', async () => {
    const execution = await executeRun({
      repoRoot,
      manifest: taskManifest(GOLDEN_TASK_ID),
      wallClock: fixedWallClock,
    })

    expect(execution.gradeDetails).toStrictEqual([])
  })
})

describe('executeRun configuration failures', () => {
  it('validates the session prompt before any trial runs', async () => {
    let created = 0
    const manifest = sessionManifest([SESSION_TASK_ID])
    delete manifest['prompt']

    await expect(
      executeRun({
        repoRoot,
        manifest,
        wallClock: fixedWallClock,
        providerFactory: () => {
          created += 1
          return recordingProvider()
        },
      }),
    ).rejects.toThrow(
      new HarnessConfigError(
        'a manifest selecting session tasks must register prompt.currentDate so the prompt is reproducible',
      ),
    )
    expect(created).toBe(0)
  })

  it('refuses a canned provider miss instead of falling back', async () => {
    const empty = createCannedProvider([], 'empty-bundle')

    const error = await executeRun({
      repoRoot,
      manifest: taskManifest(GOLDEN_TASK_ID),
      wallClock: fixedWallClock,
      providerFactory: () => empty,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(HarnessConfigError)
    expect((error as HarnessConfigError).message).toMatch(
      /^canned replay is missing a recorded response \(no canned response for payload hash [0-9a-f]{64} \(provider "persona", model "canned\/persona-v1"\); refusing to fall back\); refusing to fall back$/u,
    )
  })

  it('refuses a replay invariant failure instead of scoring it', async () => {
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'double-final',
      async *complete() {
        yield { text: 'first', done: true }
        yield { text: 'second', done: true }
      },
    }

    const thrown = await executeRun({
      repoRoot,
      manifest: taskManifest(GOLDEN_TASK_ID),
      wallClock: fixedWallClock,
      providerFactory: () => provider,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect(thrown).toBeInstanceOf(HarnessConfigError)
    expect((thrown as HarnessConfigError).message).toBe(
      'replay failure: provider "double-final" yielded a chunk after the final chunk',
    )
  })
})

describe('executeRun disposal failures', () => {
  it('records a failed disposal as a failed round and keeps the earlier round', async () => {
    let created = 0
    const providerFactory = (): CompletionProvider => {
      created += 1
      const instance = created
      return {
        ...recordingProvider(),
        dispose() {
          if (instance === 2) return Promise.reject(new Error('dispose boom'))
          return Promise.resolve()
        },
      }
    }

    const execution = await executeRun({
      repoRoot,
      manifest: taskManifest(GOLDEN_TASK_ID, { limits: { rounds: 2, maxFailureRate: 1 } }),
      wallClock: fixedWallClock,
      providerFactory,
    })

    expect(created).toBe(2)
    expect(execution.result.trials).toHaveLength(2)
    expect(execution.result.trials[0]).toMatchObject({
      round: 0,
      taskId: GOLDEN_TASK_ID,
      ok: true,
    })
    expect(execution.result.trials[1]).toMatchObject({
      round: 1,
      taskId: GOLDEN_TASK_ID,
      ok: false,
      error: 'dispose boom',
      providerOutage: false,
    })
    expect(execution.result.summary).toMatchObject({
      requestedRounds: 2,
      attempts: 2,
      completed: 1,
      failed: 1,
      failureRate: 0.5,
      trials: 2,
      failedTrials: 1,
    })
    expect(execution.result.transcripts).toHaveLength(2)
    expect(execution.transcripts.map((transcript) => transcript.round)).toStrictEqual([0, 1])
  })

  it('fails the trial when cleanup never settles, naming the trial and the limit', async () => {
    const execution = await runWithAdvancedTime(() =>
      executeRun({
        repoRoot,
        manifest: taskManifest(GOLDEN_TASK_ID),
        wallClock: fixedWallClock,
        providerFactory: () => ({
          ...recordingProvider(),
          dispose() {
            return new Promise<void>(() => undefined)
          },
        }),
      }),
    )

    expect(execution.result.trials[0]?.ok).toBe(false)
    expect(execution.result.trials[0]?.error).toBe(
      `trial 0:en:${GOLDEN_TASK_ID} cleanup exceeded 5000 ms`,
    )
    expect(execution.result.summary.failed).toBe(1)
    expect(execution.result.summary.failedTrials).toBe(1)
    expect(execution.result.transcripts).toHaveLength(1)
  })

  it('keeps the environment-creation error when there is no environment to dispose', async () => {
    let created = 0

    const execution = await executeRun({
      repoRoot,
      manifest: taskManifest(GOLDEN_TASK_ID),
      wallClock: fixedWallClock,
      providerFactory: () => {
        created += 1
        return recordingProvider()
      },
      trialTimeoutMs: 0,
    })

    expect(created).toBe(0)
    expect(execution.result.trials[0]?.ok).toBe(false)
    expect(execution.result.trials[0]?.error).toBe('timeoutMs must be a positive integer: 0')
  })

  it('marks the round failed when a trial fails, without turning it into a zero', async () => {
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'provider-boom',
      complete() {
        throw new Error('provider boom')
      },
    }

    const execution = await executeRun({
      repoRoot,
      manifest: taskManifest(GOLDEN_TASK_ID),
      wallClock: fixedWallClock,
      providerFactory: () => provider,
    })

    expect(execution.result.trials[0]).toMatchObject({
      ok: false,
      error: 'provider boom',
      providerOutage: false,
      records: 0,
    })
    expect(execution.result.summary).toMatchObject({
      requestedRounds: 1,
      attempts: 1,
      completed: 0,
      failed: 1,
      failureRate: 1,
      trials: 1,
      failedTrials: 1,
    })
    expect(execution.result.transcripts).toHaveLength(0)
    expect(execution.transcripts).toHaveLength(0)
  })
})

describe('executeRun session prompt wiring', () => {
  it('runs a single-persona session task with the persona prompt by default', async () => {
    const requests: string[][] = []
    const provider = recordingProvider(requests)

    const execution = await executeRun({
      repoRoot,
      manifest: sessionManifest([SESSION_TASK_ID]),
      wallClock: fixedWallClock,
      providerFactory: () => provider,
    })

    expect(execution.result.trials).toHaveLength(1)
    expect(execution.result.trials[0]?.ok).toBe(true)
    expect(requests.length).toBeGreaterThan(1)
    const firstSystem = requests[0]?.[0] ?? ''
    expect(firstSystem).not.toContain('You are a helpful assistant in a workplace role-play.')
    expect(execution.transcripts[0]?.records.at(-1)?.kind).toBe('session.completed')
  })

  it('runs the generic baseline prompt when the manifest registers it', async () => {
    const requests: string[][] = []
    const provider = recordingProvider(requests)

    const execution = await executeRun({
      repoRoot,
      manifest: sessionManifest([SESSION_TASK_ID], {
        prompt: {
          mode: 'generic',
          version: GENERIC_PROMPT_TEMPLATE_VERSION,
          currentDate: SESSION_DATE,
        },
      }),
      wallClock: fixedWallClock,
      providerFactory: () => provider,
    })

    expect(execution.result.trials[0]?.ok).toBe(true)
    expect(requests[0]?.[0]).toContain('You are a helpful assistant in a workplace role-play.')
    expect(requests[0]?.[0]).not.toContain('## Opening')
  })

  it('accepts the pinned harmony template version explicitly', async () => {
    const execution = await executeRun({
      repoRoot,
      manifest: sessionManifest([SESSION_TASK_ID], {
        prompt: { version: SESSION_PROMPT_TEMPLATE_VERSION, currentDate: SESSION_DATE },
      }),
      wallClock: fixedWallClock,
      providerFactory: () => recordingProvider(),
    })

    expect(execution.result.trials[0]?.ok).toBe(true)
  })

  it('passes the registered multi-persona policy to the session driver', async () => {
    const fixedRotation = await executeRun({
      repoRoot,
      manifest: probeManifest({
        tasks: {
          dataset: 'synthetic-multi-persona-session',
          version: 'm3b-v1',
          languages: ['en'],
          ids: [MULTI_PERSONA_TASK_ID],
        },
        prompt: { currentDate: SESSION_DATE },
        multiPersona: { policy: 'fixed-rotation' },
      }),
      wallClock: fixedWallClock,
      providerFactory: () => recordingProvider(),
    })
    const detPersona = await executeRun({
      repoRoot,
      manifest: probeManifest({
        tasks: {
          dataset: 'synthetic-multi-persona-session',
          version: 'm3b-v1',
          languages: ['en'],
          ids: [MULTI_PERSONA_TASK_ID],
        },
        prompt: { currentDate: SESSION_DATE },
        multiPersona: { policy: 'det-persona' },
      }),
      wallClock: fixedWallClock,
      providerFactory: () => recordingProvider(),
    })

    expect(fixedRotation.result.trials[0]?.ok).toBe(true)
    expect(detPersona.result.trials[0]?.ok).toBe(true)
    expect(fixedRotation.transcripts[0]?.jsonl).not.toBe(detPersona.transcripts[0]?.jsonl)
  })
})
