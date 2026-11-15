import { TRANSCRIPT_SCHEMA_VERSION, type TranscriptRecord } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import type { TaskEntry } from '../tasks/schema.js'
import { ProviderUnavailableError } from './canned-provider.js'
import { HarnessConfigError } from './errors.js'
import type { Grader, GraderContext, SemanticGrade, TrialRecord } from './grader.js'
import type { RunManifest } from './manifest.js'
import {
  computeInvariants,
  failedTrial,
  passTrials,
  score,
  summarize,
  toTrialOutcome,
} from './run-report.js'
import type { TrialSpeechMetrics } from './speech.js'
import { TrialTimeoutError } from './trial.js'

const ALL_INVARIANTS: RunManifest['invariants'] = [
  'transcript.schema_valid',
  'transcript.guard_clean',
  'transcript.seq_monotonic',
  'transcript.content_class',
  'response.plain_text',
]

const NO_DATA = 'no completed trial to evaluate'

const manifest: RunManifest = {
  schemaVersion: '3.0.0',
  run: { runId: 'run-report-spec', suite: 'run-report-spec', purpose: 'capability' },
  tasks: { dataset: 'tasks', version: 'v1', languages: ['en'] },
  seeds: { master: 7, algorithm: 'mulberry32' },
  grader: { id: 'fake-grader', kind: 'code', version: '1.0.0' },
  rubric: { version: 'v1' },
  limits: { rounds: 2, maxFailureRate: 0.1 },
  target: {
    metric: 'replay.deterministic_rate',
    direction: 'increase',
    minimumDetectableEffect: 0.05,
  },
  guardrails: [
    { metric: 'transcript.guard_violations', direction: 'decrease', tolerance: 0 },
    { metric: 'response.plain_text_rate', direction: 'increase', tolerance: 0 },
  ],
  invariants: ALL_INVARIANTS,
  provider: { mode: 'canned', label: 'canned', allowLive: false },
}

function withManifest(overrides: Partial<RunManifest>): RunManifest {
  return { ...manifest, ...overrides }
}

function fakeGrader(scoreImpl: Grader['score'], id = manifest.grader.id): Grader {
  return { id, kind: 'code', version: '1.0.0', score: scoreImpl }
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
    speech: speech(),
    providerOutage: false,
    ...overrides,
  }
}

function grade(overrides: Partial<SemanticGrade> = {}): SemanticGrade {
  return {
    trialId: '0:en:task-a',
    axis: 'persona',
    metric: 'semantic.persona_adherence',
    question: 'Did the persona stay in character for the whole reply?',
    probability: 0.9,
    threshold: 0.8,
    distribution: { yes: 0.9, no: 0.1 },
    servedModel: 'typesafe/jev-1.14',
    cacheHit: false,
    ...overrides,
  }
}

function taskEntry(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: 'request-deadline-extension',
    lang: 'en',
    mode: 'replay',
    domain: 'workplace',
    scenarioType: 'request',
    cefrBand: 'B1',
    speakerId: 'speaker-1',
    split: 'calibration',
    provenance: { source: 'synthetic' },
    consentScope: 'synthetic-no-consent-required',
    annotationVersions: { rubric: 'v1' },
    content: { turns: [{ role: 'user', text: 'Could we move the deadline?' }] },
    ...overrides,
  }
}

function record(seq: number, tSim: number): TranscriptRecord {
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    runId: 'run-report-spec',
    seq,
    tSim,
    tWall: 1_700_000_000_000,
    kind: 'latency.sample',
    payload: { latencyMs: 12 },
    contentClass: 'contentFree',
  }
}

describe('score', () => {
  it('returns the grader readings verbatim, including an unregistered axis', async () => {
    const trials = [trial()]
    const readings = {
      'replay.deterministic_rate': 1,
      'transcript.guard_violations': 0,
      'response.plain_text_rate': 0.75,
      'transcript.schema_valid_rate': 1,
    }
    let received: GraderContext | undefined
    const grader = fakeGrader((context) => {
      received = context
      return Promise.resolve(readings)
    })

    await expect(score(manifest, grader, trials)).resolves.toStrictEqual(readings)
    expect(received).toStrictEqual({ manifest, trials })
  })

  it('never infers a missing target axis', async () => {
    const grader = fakeGrader(() =>
      Promise.resolve({
        'transcript.guard_violations': 0,
        'response.plain_text_rate': 1,
      }),
    )

    await expect(score(manifest, grader, [trial()])).rejects.toThrowError(
      new HarnessConfigError(
        'grader "fake-grader" did not measure registered axis(es): replay.deterministic_rate',
      ),
    )
  })

  it('names every missing registered axis once, in registration order', async () => {
    const grader = fakeGrader(() => Promise.resolve({ 'transcript.schema_valid_rate': 1 }))

    const failure = score(manifest, grader, [trial()])
    await expect(failure).rejects.toBeInstanceOf(HarnessConfigError)
    await expect(failure).rejects.toThrowError(
      'grader "fake-grader" did not measure registered axis(es): replay.deterministic_rate, transcript.guard_violations, response.plain_text_rate',
    )
  })

  it('never accepts a missing guardrail axis, even when the target is measured', async () => {
    const grader = fakeGrader(() =>
      Promise.resolve({ 'replay.deterministic_rate': 1, 'transcript.guard_violations': 0 }),
    )

    await expect(score(manifest, grader, [trial()])).rejects.toThrowError(
      'grader "fake-grader" did not measure registered axis(es): response.plain_text_rate',
    )
  })

  it('turns a grader failure into a configuration error, never a score of zero', async () => {
    const grader = fakeGrader(() => Promise.reject(new Error('model timed out')))

    await expect(score(manifest, grader, [trial()])).rejects.toThrowError(
      new HarnessConfigError(
        'grader "fake-grader" failed: model timed out; a failed grader call is never a score',
      ),
    )
  })

  it('renders a non-Error rejection without losing it', async () => {
    const grader = fakeGrader(() => Promise.reject('cable unplugged'))

    await expect(score(manifest, grader, [trial()])).rejects.toThrowError(
      'grader "fake-grader" failed: cable unplugged; a failed grader call is never a score',
    )
  })

  it('rejects an empty reading with the <root> path', async () => {
    const grader = fakeGrader(() => Promise.resolve({}))

    await expect(score(manifest, grader, [trial()])).rejects.toThrowError(
      new HarnessConfigError(
        'grader "fake-grader" returned invalid metric readings: <root>: at least one per-axis metric is required',
      ),
    )
  })

  it('rejects an invalid reading with its field path', async () => {
    const grader = fakeGrader(() =>
      Promise.resolve({ 'replay.deterministic_rate': 'high' } as unknown as Record<string, number>),
    )

    await expect(score(manifest, grader, [trial()])).rejects.toThrowError(
      new HarnessConfigError(
        'grader "fake-grader" returned invalid metric readings: replay.deterministic_rate: Invalid input: expected number, received string',
      ),
    )
  })

  it('lists every invalid reading in one message', async () => {
    const grader = fakeGrader(() =>
      Promise.resolve({ 'Bad Key': 1, 'c-d': 'x' } as unknown as Record<string, number>),
    )

    await expect(score(manifest, grader, [trial()])).rejects.toThrowError(
      new HarnessConfigError(
        'grader "fake-grader" returned invalid metric readings: Bad Key: Invalid key in record; c-d: Invalid input: expected number, received string',
      ),
    )
  })
})

describe('computeInvariants', () => {
  it('emits only the registered invariants, in the fixed invariant order', () => {
    const results = computeInvariants(
      withManifest({ invariants: ['response.plain_text', 'transcript.seq_monotonic'] }),
      [trial()],
    )

    expect(results).toStrictEqual([
      {
        id: 'transcript.seq_monotonic',
        ok: true,
        detail: 'every completed transcript has strictly increasing seq',
      },
      {
        id: 'response.plain_text',
        ok: true,
        detail: 'every completed reply is plain text with no Markdown, no emoji and no empty reply',
      },
    ])
  })

  it('reports the no-data detail for every required invariant when nothing completed', () => {
    const results = computeInvariants(manifest, [trial({ ok: false }), trial({ ok: false })])

    expect(results).toStrictEqual(ALL_INVARIANTS.map((id) => ({ id, ok: false, detail: NO_DATA })))
  })

  it('passes all five invariants on one clean completed trial', () => {
    expect(computeInvariants(manifest, [trial()])).toStrictEqual([
      {
        id: 'transcript.schema_valid',
        ok: true,
        detail: 'all 1 completed transcripts parse against the transcript schema',
      },
      {
        id: 'transcript.guard_clean',
        ok: true,
        detail: '0 §3.2 guard violation(s) across completed transcripts',
      },
      {
        id: 'transcript.seq_monotonic',
        ok: true,
        detail: 'every completed transcript has strictly increasing seq',
      },
      {
        id: 'transcript.content_class',
        ok: true,
        detail: 'every text-bearing record is restricted and operational records are contentFree',
      },
      {
        id: 'response.plain_text',
        ok: true,
        detail: 'every completed reply is plain text with no Markdown, no emoji and no empty reply',
      },
    ])
  })

  it('ignores a failed trial, even when its transcript is dirty', () => {
    const failed = trial({
      ok: false,
      schemaValid: false,
      sequenceValid: false,
      contentClassValid: false,
      violations: [{ code: 'grant_conflict', message: 'two grants live at once' }],
      speech: speech({ plainTextRate: 0, emojiCount: 3, markdownCount: 1, emptyResponses: 2 }),
    })

    expect(computeInvariants(manifest, [failed, trial()])).toStrictEqual([
      {
        id: 'transcript.schema_valid',
        ok: true,
        detail: 'all 1 completed transcripts parse against the transcript schema',
      },
      {
        id: 'transcript.guard_clean',
        ok: true,
        detail: '0 §3.2 guard violation(s) across completed transcripts',
      },
      {
        id: 'transcript.seq_monotonic',
        ok: true,
        detail: 'every completed transcript has strictly increasing seq',
      },
      {
        id: 'transcript.content_class',
        ok: true,
        detail: 'every text-bearing record is restricted and operational records are contentFree',
      },
      {
        id: 'response.plain_text',
        ok: true,
        detail: 'every completed reply is plain text with no Markdown, no emoji and no empty reply',
      },
    ])
  })

  it('fails schema validity when any completed transcript does not parse', () => {
    const results = computeInvariants(manifest, [trial(), trial({ schemaValid: false })])

    expect(results[0]).toStrictEqual({
      id: 'transcript.schema_valid',
      ok: false,
      detail: 'all 2 completed transcripts parse against the transcript schema',
    })
    expect(results.slice(1).map((result) => result.ok)).toStrictEqual([true, true, true, true])
  })

  it('counts guard violations across every completed transcript', () => {
    const results = computeInvariants(manifest, [
      trial({ violations: [{ code: 'grant_conflict', message: 'two grants live at once' }] }),
      trial({
        violations: [
          { code: 'response_stale_grant', message: 'reply names an expired grant' },
          { code: 'seq_not_monotonic', message: 'seq went backwards' },
        ],
      }),
    ])

    expect(results[1]).toStrictEqual({
      id: 'transcript.guard_clean',
      ok: false,
      detail: '3 §3.2 guard violation(s) across completed transcripts',
    })
  })

  it('fails sequence monotonicity when any completed transcript is out of order', () => {
    const results = computeInvariants(manifest, [trial(), trial({ sequenceValid: false })])

    expect(results[2]).toStrictEqual({
      id: 'transcript.seq_monotonic',
      ok: false,
      detail: 'every completed transcript has strictly increasing seq',
    })
  })

  it('fails the content class when any completed record is classified wrongly', () => {
    const results = computeInvariants(manifest, [trial(), trial({ contentClassValid: false })])

    expect(results[3]).toStrictEqual({
      id: 'transcript.content_class',
      ok: false,
      detail: 'every text-bearing record is restricted and operational records are contentFree',
    })
  })

  it('fails plain text when a completed trial produced no speech metrics', () => {
    const results = computeInvariants(manifest, [trial(), trial({ speech: undefined })])

    expect(results[4]).toStrictEqual({
      id: 'response.plain_text',
      ok: false,
      detail: 'every completed reply is plain text with no Markdown, no emoji and no empty reply',
    })
  })

  it.each([
    { label: 'a partly Markdown reply', overrides: { plainTextRate: 0.5 } },
    { label: 'a fractional rate below one', overrides: { plainTextRate: 0.999 } },
    { label: 'an emoji', overrides: { emojiCount: 1 } },
    { label: 'Markdown', overrides: { markdownCount: 2 } },
    { label: 'an empty reply', overrides: { emptyResponses: 1 } },
  ])('fails plain text for $label while the other readings are clean', ({ overrides }) => {
    const results = computeInvariants(withManifest({ invariants: ['response.plain_text'] }), [
      trial(),
      trial({ speech: speech(overrides) }),
    ])

    expect(results).toStrictEqual([
      {
        id: 'response.plain_text',
        ok: false,
        detail: 'every completed reply is plain text with no Markdown, no emoji and no empty reply',
      },
    ])
  })
})

describe('summarize', () => {
  it('reports attempts, completed and failed rounds with a failure rate', () => {
    expect(summarize(manifest, [trial(), trial({ ok: false }), trial()], 1)).toStrictEqual({
      requestedRounds: 2,
      attempts: 2,
      completed: 1,
      failed: 1,
      failureRate: 0.5,
      trials: 3,
      failedTrials: 1,
    })
  })

  it('reports a clean round with a zero failure rate', () => {
    expect(summarize(manifest, [trial()], 0)).toStrictEqual({
      requestedRounds: 2,
      attempts: 2,
      completed: 2,
      failed: 0,
      failureRate: 0,
      trials: 1,
      failedTrials: 0,
    })
  })

  it('reports a failure rate of one when no round was attempted', () => {
    expect(
      summarize(withManifest({ limits: { rounds: 0, maxFailureRate: 0.1 } }), [], 0),
    ).toStrictEqual({
      requestedRounds: 0,
      attempts: 0,
      completed: 0,
      failed: 0,
      failureRate: 1,
      trials: 0,
      failedTrials: 0,
    })
  })
})

describe('passTrials', () => {
  it('passes on the harness outcome alone when there are no semantic details', () => {
    const outcomes = passTrials(
      [trial(), trial({ ok: false, round: 1 }), trial({ round: 2, lang: 'fr' })],
      [],
    )

    expect(outcomes).toStrictEqual([
      { round: 0, taskId: 'task-a', lang: 'en', passed: true },
      { round: 1, taskId: 'task-a', lang: 'en', passed: false },
      { round: 2, taskId: 'task-a', lang: 'fr', passed: true },
    ])
  })

  it.each([
    { label: 'above the threshold', probability: 0.9, passed: true },
    { label: 'exactly on the threshold', probability: 0.8, passed: true },
    { label: 'below the threshold', probability: 0.79, passed: false },
  ])('judges one detail $label', ({ probability, passed }) => {
    expect(passTrials([trial()], [grade({ probability })])).toStrictEqual([
      { round: 0, taskId: 'task-a', lang: 'en', passed },
    ])
  })

  it('requires every detail of one trial to clear its own threshold', () => {
    const details = [
      grade({ metric: 'semantic.persona_adherence', probability: 0.95, threshold: 0.8 }),
      grade({ metric: 'semantic.task_completion', probability: 0.7, threshold: 0.8 }),
    ]

    expect(passTrials([trial()], details)).toStrictEqual([
      { round: 0, taskId: 'task-a', lang: 'en', passed: false },
    ])
    expect(
      passTrials(
        [trial()],
        details.map((row) => ({ ...row, probability: 0.9 })),
      ),
    ).toStrictEqual([{ round: 0, taskId: 'task-a', lang: 'en', passed: true }])
  })

  it('applies duplicate rows for one trial and ignores a row with no matching trial', () => {
    const details = [
      grade({ probability: 0.95 }),
      grade({ probability: 0.95, metric: 'semantic.task_completion' }),
      { ...grade({ trialId: '9:fr:unrelated-task' }), probability: 0.1 },
    ]

    expect(passTrials([trial()], details)).toStrictEqual([
      { round: 0, taskId: 'task-a', lang: 'en', passed: true },
    ])

    const contradicted = [details[0] as SemanticGrade, { ...grade({ probability: 0.1 }) }]
    expect(passTrials([trial()], contradicted)).toStrictEqual([
      { round: 0, taskId: 'task-a', lang: 'en', passed: false },
    ])
  })

  it('keys details by round, language and task id, never by task id alone', () => {
    const trials = [
      trial({ round: 0, lang: 'en', taskId: 'task-a' }),
      trial({ round: 0, lang: 'fr', taskId: 'task-a' }),
      trial({ round: 1, lang: 'en', taskId: 'task-a' }),
    ]
    const details = [grade({ trialId: '0:fr:task-a', probability: 0.2 })]

    expect(passTrials(trials, details)).toStrictEqual([
      { round: 0, taskId: 'task-a', lang: 'en', passed: true },
      { round: 0, taskId: 'task-a', lang: 'fr', passed: false },
      { round: 1, taskId: 'task-a', lang: 'en', passed: true },
    ])
  })

  it('never passes a failed trial, even when its details clear the threshold', () => {
    expect(passTrials([trial({ ok: false })], [grade({ probability: 1 })])).toStrictEqual([
      { round: 0, taskId: 'task-a', lang: 'en', passed: false },
    ])
  })
})

describe('failedTrial', () => {
  const task = taskEntry()

  it('records one failed trial with empty artifacts and no score', () => {
    expect(failedTrial(2, task, new Error('stream closed before the first token'))).toStrictEqual({
      round: 2,
      taskId: 'request-deadline-extension',
      lang: 'en',
      ok: false,
      records: [],
      violations: [],
      schemaValid: false,
      sequenceValid: false,
      contentClassValid: false,
      error: 'stream closed before the first token',
      providerOutage: false,
      task,
    })
  })

  it('marks a provider outage as an infrastructure failure, not a quality signal', () => {
    const error = new ProviderUnavailableError('no canned response', 'canned')

    expect(failedTrial(0, task, error)).toStrictEqual({
      round: 0,
      taskId: 'request-deadline-extension',
      lang: 'en',
      ok: false,
      records: [],
      violations: [],
      schemaValid: false,
      sequenceValid: false,
      contentClassValid: false,
      error: 'no canned response',
      providerOutage: true,
      task,
    })
  })

  it('marks a timed-out trial as a provider outage', () => {
    const error = new TrialTimeoutError('1:en:request-deadline-extension', 30_000)
    const failed = failedTrial(1, task, error)

    expect(failed.providerOutage).toBe(true)
    expect(failed.error).toBe(
      'trial 1:en:request-deadline-extension exceeded its 30000 ms timeout; the provider or stream is stalled',
    )
  })

  it('renders a thrown non-Error and keeps the outage flag false', () => {
    const failed = failedTrial(0, task, 'socket hang up')

    expect(failed.error).toBe('socket hang up')
    expect(failed.providerOutage).toBe(false)
  })
})

describe('toTrialOutcome', () => {
  const sha = 'a'.repeat(64)

  it('records the transcript identity and the last simulated timestamp', () => {
    expect(
      toTrialOutcome(
        trial({
          round: 1,
          records: [record(0, 100), record(1, 200), record(2, 350)],
          transcriptSha256: sha,
          transcriptPath: 'transcripts/round-1/en/task-a.jsonl',
        }),
      ),
    ).toStrictEqual({
      round: 1,
      taskId: 'task-a',
      lang: 'en',
      ok: true,
      records: 3,
      transcriptSha256: sha,
      transcriptPath: 'transcripts/round-1/en/task-a.jsonl',
      simDurationMs: 350,
      providerOutage: false,
    })
  })

  it('omits every optional field a trial did not produce', () => {
    expect(toTrialOutcome(trial())).toStrictEqual({
      round: 0,
      taskId: 'task-a',
      lang: 'en',
      ok: true,
      records: 0,
      providerOutage: false,
    })
  })

  it('keeps the error text and outage flag of a failed trial', () => {
    expect(
      toTrialOutcome(trial({ ok: false, error: 'provider outage', providerOutage: true })),
    ).toStrictEqual({
      round: 0,
      taskId: 'task-a',
      lang: 'en',
      ok: false,
      records: 0,
      error: 'provider outage',
      providerOutage: true,
    })
  })
})
