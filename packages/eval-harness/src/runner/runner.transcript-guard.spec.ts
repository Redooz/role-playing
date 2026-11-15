import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TRANSCRIPT_SCHEMA_VERSION,
  type ContentClass,
  type TranscriptRecord,
} from '@rp/session-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReplayModule from './replay.js'
import type { CompletionProvider } from './canned-provider.js'
import { executeRun } from './runner.js'

/**
 * `executeRun`'s §2.1 transcript guard, driven through a stubbed producer.
 *
 * The replay and session producers only ever emit §2.1 events with the matching
 * content class, so `executeRun`'s own transcript validation (record kind,
 * guard violations, content class) is unreachable through a real task file.
 * This spec replaces `replayTask` with a fabricator and keeps every other
 * export of `./replay.js` real, so the runner itself, the guards, the grader,
 * the result artifact and the verdict all run for real.
 */

const producer = vi.hoisted(() => ({
  next: null as null | (() => Promise<unknown>),
  calls: 0,
}))

vi.mock('./replay.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ReplayModule>()
  return {
    ...actual,
    async replayTask(): Promise<unknown> {
      producer.calls += 1
      if (producer.next === null) throw new Error('no fabricated replay installed')
      return producer.next()
    },
  }
})

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const TASK_ID = 'en-b1-report-deadline-001'
const RUN_ID = 'runner-transcript-guard'
const FIXED_WALL = (): number => 1_700_000_000_000

/** The clean-run readings every guardrail is compared against. */
const BASELINE_METRICS = {
  'replay.deterministic_rate': 1,
  'transcript.schema_valid_rate': 1,
  'transcript.content_class_rate': 1,
  'transcript.guard_violations': 0,
  'run.failure_rate': 0,
} as const

/** A replay-only manifest that registers every metric this spec reads. */
function guardManifest(): Record<string, unknown> {
  return {
    schemaVersion: '3.0.0',
    run: { runId: RUN_ID, suite: RUN_ID, purpose: 'regression' },
    tasks: {
      dataset: 'synthetic-workplace',
      version: 'v1',
      languages: ['en'],
      ids: [TASK_ID],
    },
    seeds: { master: 20261025, algorithm: 'mulberry32' },
    grader: { id: 'deterministic-invariants', kind: 'code', version: '1.0.0' },
    rubric: { version: 'm0-harness-v1' },
    limits: { rounds: 1, maxFailureRate: 0 },
    target: {
      metric: 'replay.deterministic_rate',
      direction: 'increase',
      minimumDetectableEffect: 0,
    },
    guardrails: [
      { metric: 'transcript.schema_valid_rate', direction: 'increase', tolerance: 0 },
      { metric: 'transcript.content_class_rate', direction: 'increase', tolerance: 0 },
      { metric: 'transcript.guard_violations', direction: 'decrease', tolerance: 0 },
      { metric: 'run.failure_rate', direction: 'decrease', tolerance: 0 },
    ],
    invariants: [
      'transcript.schema_valid',
      'transcript.guard_clean',
      'transcript.seq_monotonic',
      'transcript.content_class',
    ],
    provider: { mode: 'canned', label: 'runner-transcript-guard', allowLive: false },
    baseline: { runId: `${RUN_ID}-baseline`, metrics: BASELINE_METRICS },
  }
}

/** The mocked producer never reaches the provider; this only proves that. */
function unusedProvider(): CompletionProvider & { readonly calls: () => number } {
  let calls = 0
  return {
    kind: 'canned',
    label: 'unused',
    complete() {
      calls += 1
      throw new Error('the fabricated replay must not call the provider')
    },
    calls: () => calls,
  }
}

function record(
  seq: number,
  kind: string,
  payload: unknown,
  contentClass: ContentClass,
): TranscriptRecord {
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    runId: RUN_ID,
    executionId: 'exec-transcript-guard',
    seq,
    tSim: seq * 10,
    tWall: FIXED_WALL() + seq,
    kind,
    payload,
    contentClass,
  }
}

const GRANT_A = {
  grant: {
    turnId: 'turn-0',
    grantId: 'grant-0',
    personaId: 'manager',
    expiresAt: '2026-11-08T00:01:00.000Z',
  },
} as const

const GRANT_B = {
  grant: {
    turnId: 'turn-1',
    grantId: 'grant-1',
    personaId: 'peer',
    expiresAt: '2026-11-08T00:02:00.000Z',
  },
} as const

const SESSION_STARTED = {
  sessionId: 'session-0',
  clockMode: 'simulated',
  lang: 'en',
} as const

async function runFabricated(records: readonly TranscriptRecord[]) {
  const provider = unusedProvider()
  producer.next = async () => ({ records, jsonl: `${RUN_ID}: ${records.length} record(s)\n` })
  const execution = await executeRun({
    repoRoot,
    manifest: guardManifest(),
    wallClock: FIXED_WALL,
    providerFactory: () => provider,
  })
  return { execution, provider }
}

function invariant(result: { readonly invariants: readonly { id: string }[] }, id: string) {
  return result.invariants.find((entry) => entry.id === id)
}

describe('executeRun §2.1 transcript guard', () => {
  beforeEach(() => {
    producer.calls = 0
    producer.next = null
  })

  it('refuses a record kind that is not a §2.1 event, naming the kind', async () => {
    const built = await runFabricated([
      record(0, 'turn.granted', GRANT_A, 'contentFree'),
      record(1, 'latency.sample', { elapsedMs: 12 }, 'contentFree'),
    ])
    const { result } = built.execution

    // The guard throws `HarnessConfigError` inside the per-trial `try`, so the
    // runner records it as a failed trial rather than aborting the whole run;
    // the exact discrimination message is what proves the typed error was built.
    expect(producer.calls).toBe(1)
    expect(built.provider.calls()).toBe(0)
    expect(result.trials).toHaveLength(1)
    expect(result.trials[0]).toMatchObject({
      ok: false,
      records: 0,
      providerOutage: false,
      error:
        'transcript record kind "latency.sample" is not a §2.1 event; the replay path cannot emit it',
    })
    expect(result.transcripts).toHaveLength(0)
    expect(built.execution.transcripts).toHaveLength(0)
    expect(result.summary).toMatchObject({
      attempts: 1,
      completed: 0,
      failed: 1,
      failureRate: 1,
      failedTrials: 1,
    })
    expect(result.verdict.status).toBe('inconclusive')
  })

  it('counts a guard violation in the metrics and fails the guard_clean invariant', async () => {
    const built = await runFabricated([
      record(0, 'turn.granted', GRANT_A, 'contentFree'),
      // A second grant while the first is still current: §3.2 grant_conflict.
      record(1, 'turn.granted', GRANT_B, 'contentFree'),
    ])
    const { result } = built.execution

    expect(built.provider.calls()).toBe(0)
    expect(producer.calls).toBe(1)
    expect(result.trials).toHaveLength(1)
    expect(result.trials[0]).toMatchObject({ ok: true, records: 2, providerOutage: false })

    expect(result.metrics['transcript.guard_violations']).toBe(1)
    expect(result.metrics['transcript.schema_valid_rate']).toBe(1)
    expect(result.metrics['transcript.content_class_rate']).toBe(1)

    expect(invariant(result, 'transcript.guard_clean')).toStrictEqual({
      id: 'transcript.guard_clean',
      ok: false,
      detail: '1 §3.2 guard violation(s) across completed transcripts',
    })
    expect(invariant(result, 'transcript.schema_valid')).toStrictEqual({
      id: 'transcript.schema_valid',
      ok: true,
      detail: 'all 1 completed transcripts parse against the transcript schema',
    })
    expect(invariant(result, 'transcript.content_class')).toStrictEqual({
      id: 'transcript.content_class',
      ok: true,
      detail: 'every text-bearing record is restricted and operational records are contentFree',
    })

    expect(result.verdict.status).toBe('rejected')
    expect(result.verdict.reasons).toContain('invariant(s) failed: transcript.guard_clean')
    expect(
      result.verdict.guardrails.find((axis) => axis.metric === 'transcript.guard_violations'),
    ).toStrictEqual({
      kind: 'guardrail',
      metric: 'transcript.guard_violations',
      direction: 'decrease',
      baseline: 0,
      value: 1,
      delta: 1,
      improvement: -1,
      required: 0,
      status: 'fail',
      reason: 'guardrail "transcript.guard_violations" regressed by 1, beyond the tolerated 0',
    })
    expect(result.summary).toMatchObject({ attempts: 1, completed: 1, failedTrials: 0 })
  })

  it('fails the content-class invariant when one record carries the wrong class', async () => {
    const built = await runFabricated([
      record(0, 'turn.granted', GRANT_A, 'contentFree'),
      // `session.started` is operational, so `restricted` is the wrong class.
      record(1, 'session.started', SESSION_STARTED, 'restricted'),
    ])
    const { result } = built.execution

    expect(built.provider.calls()).toBe(0)
    expect(result.trials).toHaveLength(1)
    expect(result.trials[0]).toMatchObject({ ok: true, records: 2 })

    expect(result.metrics['transcript.guard_violations']).toBe(0)
    expect(result.metrics['transcript.content_class_rate']).toBe(0)

    expect(invariant(result, 'transcript.content_class')).toStrictEqual({
      id: 'transcript.content_class',
      ok: false,
      detail: 'every text-bearing record is restricted and operational records are contentFree',
    })
    expect(invariant(result, 'transcript.guard_clean')).toStrictEqual({
      id: 'transcript.guard_clean',
      ok: true,
      detail: '0 §3.2 guard violation(s) across completed transcripts',
    })

    expect(result.verdict.status).toBe('rejected')
    expect(result.verdict.reasons).toContain('invariant(s) failed: transcript.content_class')
    expect(
      result.verdict.guardrails.find((axis) => axis.metric === 'transcript.content_class_rate'),
    ).toStrictEqual({
      kind: 'guardrail',
      metric: 'transcript.content_class_rate',
      direction: 'increase',
      baseline: 1,
      value: 0,
      delta: -1,
      improvement: -1,
      required: 0,
      status: 'fail',
      reason: 'guardrail "transcript.content_class_rate" regressed by 1, beyond the tolerated 0',
    })
  })

  it('keeps a clean two-record transcript accepted', async () => {
    const built = await runFabricated([
      record(0, 'turn.granted', GRANT_A, 'contentFree'),
      record(1, 'session.completed', {}, 'contentFree'),
    ])
    const { result } = built.execution

    expect(result.metrics['transcript.guard_violations']).toBe(0)
    expect(result.metrics['transcript.content_class_rate']).toBe(1)
    expect(result.invariants.every((entry) => entry.ok)).toBe(true)
    expect(result.verdict.status).toBe('accepted')
  })
})
