import type { Violation } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import {
  DETERMINISTIC_GRADER_ID,
  DETERMINISTIC_GRADER_KIND,
  DETERMINISTIC_GRADER_VERSION,
  METRIC_CONTENT_CLASS_RATE,
  METRIC_DETERMINISTIC_RATE,
  METRIC_EMOJI_COUNT,
  METRIC_FAILURE_RATE,
  METRIC_GUARD_VIOLATIONS,
  METRIC_MARKDOWN_COUNT,
  METRIC_PLAIN_TEXT_RATE,
  METRIC_SCHEMA_VALID_RATE,
  createDeterministicInvariantGrader,
  type GraderContext,
  type TrialRecord,
} from './grader.js'
import type { RunManifest } from './manifest.js'
import type { TrialSpeechMetrics } from './speech.js'

/**
 * The deterministic grader only reads `context.trials`; the manifest is carried
 * for symmetry with semantic graders (which need the rubric and languages).
 */
const manifest: RunManifest = {
  schemaVersion: '3.0.0',
  run: { runId: 'grader-spec', suite: 'grader-spec', purpose: 'capability' },
  tasks: { dataset: 'tasks', version: 'v1', languages: ['en'] },
  seeds: { master: 7, algorithm: 'mulberry32' },
  grader: { id: 'deterministic-invariants', kind: 'code', version: '1.0.0' },
  rubric: { version: 'v1' },
  limits: { rounds: 2, maxFailureRate: 0.1 },
  target: {
    metric: 'transcript.schema_valid_rate',
    direction: 'increase',
    minimumDetectableEffect: 0.05,
  },
  guardrails: [{ metric: 'transcript.guard_violations', direction: 'decrease', tolerance: 0 }],
  invariants: ['transcript.schema_valid', 'transcript.guard_clean'],
  provider: { mode: 'canned', label: 'canned', allowLive: false },
}

function violations(count: number): Violation[] {
  return Array.from({ length: count }, (_, index) => ({
    code: 'seq_not_monotonic',
    message: `violation ${index}`,
  }))
}

function speech(overrides: Partial<TrialSpeechMetrics> = {}): TrialSpeechMetrics {
  return { plainTextRate: 1, emojiCount: 0, markdownCount: 0, emptyResponses: 0, ...overrides }
}

function trial(overrides: Partial<TrialRecord> = {}): TrialRecord {
  return {
    round: 0,
    taskId: 'task-a',
    lang: 'en',
    ok: true,
    records: [],
    violations: [],
    schemaValid: true,
    sequenceValid: true,
    contentClassValid: true,
    providerOutage: false,
    ...overrides,
  }
}

function context(trials: readonly TrialRecord[]): GraderContext {
  return { manifest, trials }
}

describe('deterministic invariant grader', () => {
  it('declares a code grader with the exact identity', () => {
    const grader = createDeterministicInvariantGrader()

    expect(grader.id).toBe('deterministic-invariants')
    expect(grader.kind).toBe('code')
    expect(grader.version).toBe('1.0.0')
    expect(grader.model).toBeUndefined()
    expect(grader.rubricVersion).toBeUndefined()
    expect(grader.details).toBeUndefined()
  })

  it('exports the identity and metric names the run artifact records', () => {
    expect(DETERMINISTIC_GRADER_ID).toBe('deterministic-invariants')
    expect(DETERMINISTIC_GRADER_KIND).toBe('code')
    expect(DETERMINISTIC_GRADER_VERSION).toBe('1.0.0')
    expect(METRIC_DETERMINISTIC_RATE).toBe('replay.deterministic_rate')
    expect(METRIC_GUARD_VIOLATIONS).toBe('transcript.guard_violations')
    expect(METRIC_SCHEMA_VALID_RATE).toBe('transcript.schema_valid_rate')
    expect(METRIC_CONTENT_CLASS_RATE).toBe('transcript.content_class_rate')
    expect(METRIC_FAILURE_RATE).toBe('run.failure_rate')
    expect(METRIC_PLAIN_TEXT_RATE).toBe('response.plain_text_rate')
    expect(METRIC_EMOJI_COUNT).toBe('response.emoji_count')
    expect(METRIC_MARKDOWN_COUNT).toBe('response.markdown_count')
  })

  it('scores an empty trial list as a full failure with no readings', async () => {
    const score = await createDeterministicInvariantGrader().score(context([]))

    expect(score).toStrictEqual({
      'replay.deterministic_rate': 0,
      'transcript.guard_violations': 0,
      'transcript.schema_valid_rate': 0,
      'transcript.content_class_rate': 0,
      'run.failure_rate': 1,
      'response.plain_text_rate': 0,
      'response.emoji_count': 0,
      'response.markdown_count': 0,
    })
  })

  it('scores every axis over completed trials and excludes failed trials', async () => {
    const score = await createDeterministicInvariantGrader().score(
      context([
        trial({
          taskId: 'task-1',
          jsonl: 'A',
          violations: violations(2),
          speech: speech({ emojiCount: 2, markdownCount: 1 }),
        }),
        trial({
          taskId: 'task-1',
          jsonl: 'A',
          schemaValid: false,
          speech: speech({ plainTextRate: 0.5, emojiCount: 1 }),
        }),
        trial({
          taskId: 'task-2',
          jsonl: 'B',
          contentClassValid: false,
          violations: violations(1),
          speech: speech({ markdownCount: 3 }),
        }),
        trial({
          ok: false,
          taskId: 'task-4',
          violations: violations(5),
          schemaValid: false,
          contentClassValid: false,
          speech: speech({ plainTextRate: 0, emojiCount: 9, markdownCount: 9 }),
        }),
        trial({ taskId: 'task-3', speech: undefined }),
        trial({ taskId: 'task-2', jsonl: 'C', speech: speech({ emojiCount: 4 }) }),
      ]),
    )

    expect(score).toStrictEqual({
      'replay.deterministic_rate': 1 / 2,
      'transcript.guard_violations': 3,
      'transcript.schema_valid_rate': 4 / 5,
      'transcript.content_class_rate': 4 / 5,
      'run.failure_rate': 1 / 6,
      'response.plain_text_rate': 3 / 4,
      'response.emoji_count': 7,
      'response.markdown_count': 4,
    })
  })
})

describe('replay determinism reading', () => {
  async function deterministicRate(trials: readonly TrialRecord[]): Promise<number | undefined> {
    const score = await createDeterministicInvariantGrader().score(context(trials))
    return score['replay.deterministic_rate']
  }

  it('reports 0 when completed trials produced no transcript at all', async () => {
    await expect(deterministicRate([trial(), trial({ taskId: 'task-b' })])).resolves.toBe(0)
  })

  it('counts a same-task, same-language group with identical JSONL as deterministic', async () => {
    await expect(
      deterministicRate([trial({ jsonl: 'A' }), trial({ round: 1, jsonl: 'A' })]),
    ).resolves.toBe(1)
  })

  it('reports 0 when a repeated group diverges byte-wise', async () => {
    await expect(
      deterministicRate([trial({ jsonl: 'A' }), trial({ round: 1, jsonl: 'B' })]),
    ).resolves.toBe(0)
  })

  it('treats a single-trial group as deterministic and averages over groups', async () => {
    await expect(
      deterministicRate([
        trial({ taskId: 'task-1', jsonl: 'A' }),
        trial({ taskId: 'task-1', round: 1, jsonl: 'A' }),
        trial({ taskId: 'task-2', jsonl: 'B' }),
        trial({ taskId: 'task-2', round: 1, jsonl: 'C' }),
        trial({ taskId: 'task-3', jsonl: 'D' }),
      ]),
    ).resolves.toBe(2 / 3)
  })

  it('keeps the same task id apart across languages', async () => {
    await expect(
      deterministicRate([
        trial({ lang: 'en', taskId: 'task-1', jsonl: 'A' }),
        trial({ lang: 'fr', taskId: 'task-1', jsonl: 'B' }),
      ]),
    ).resolves.toBe(1)
  })
})
