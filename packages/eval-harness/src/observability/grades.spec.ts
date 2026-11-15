import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson } from '@rp/shared'
import {
  TRANSCRIPT_SCHEMA_VERSION,
  type ContentClass,
  type TranscriptRecord,
} from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import {
  GRADES_SCHEMA_VERSION,
  buildGrades,
  gradeScoreSchema,
  gradeStatusSchema,
  gradeValueKindSchema,
  gradesJsonl,
  trialGradeSchema,
  type TrialGrade,
} from './grades.js'
import type { GraderRegistration } from '../runner/manifest.js'
import type { SemanticGrade } from '../runner/grader.js'
import type { TrialOutcome } from '../runner/results.js'
import { executeRun, type EvaluationRun, type TrialTranscriptFile } from '../runner/runner.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const manifestPath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')

const fixedWallClock = (): number => 1_700_000_000_000
const EN_TASK = 'en-b1-report-deadline-001'
const EN_TRIAL_ID = `0:en:${EN_TASK}`
const EN_EXECUTION_ID = 'm0-canned-replay-20231114T221320Z-c80a1f49'

function loadManifestRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
}

async function run(): Promise<EvaluationRun> {
  return executeRun({ repoRoot, manifest: loadManifestRaw(), wallClock: fixedWallClock })
}

let baseExecution: EvaluationRun | undefined

/** One canned execution shared by the edge-path tests; it is never mutated. */
async function base(): Promise<EvaluationRun> {
  baseExecution ??= await run()
  return baseExecution
}

function trialFor(execution: EvaluationRun, lang: 'en' | 'fr', taskId: string): TrialOutcome {
  const trial = execution.result.trials.find(
    (candidate) => candidate.lang === lang && candidate.taskId === taskId,
  )
  if (trial === undefined) throw new Error(`fixture trial not found: ${lang}:${taskId}`)
  return trial
}

function firstTranscript(execution: EvaluationRun): TrialTranscriptFile {
  const [first] = execution.transcripts
  if (first === undefined) throw new Error('fixture execution has no transcripts')
  return first
}

/** A graded EN trial with controlled counts, used by the edge-path tests. */
function gradedTrial(execution: EvaluationRun): TrialOutcome {
  return { ...trialFor(execution, 'en', EN_TASK), records: 2, simDurationMs: 42 }
}

function executionWithTrial(
  execution: EvaluationRun,
  trial: TrialOutcome,
  records: readonly TranscriptRecord[],
): EvaluationRun {
  const source = firstTranscript(execution)
  return {
    ...execution,
    result: { ...execution.result, trials: [trial] },
    transcripts: [
      { ...source, taskId: trial.taskId, lang: trial.lang, round: trial.round, records },
    ],
  }
}

function withGradeDetails(
  execution: EvaluationRun,
  details: readonly SemanticGrade[],
): EvaluationRun {
  return { ...execution, gradeDetails: details }
}

function withGrader(execution: EvaluationRun, grader: GraderRegistration): EvaluationRun {
  return {
    ...execution,
    result: {
      ...execution.result,
      manifest: { ...execution.result.manifest, grader },
    },
  }
}

function withRubricVersion(execution: EvaluationRun, version: string): EvaluationRun {
  return {
    ...execution,
    result: {
      ...execution.result,
      manifest: { ...execution.result.manifest, rubric: { version } },
    },
  }
}

interface RecordInit {
  readonly seq: number
  readonly kind: string
  readonly payload?: unknown
  readonly contentClass?: ContentClass
  readonly schemaVersion?: string
}

function makeRecord(init: RecordInit): TranscriptRecord {
  return {
    schemaVersion: init.schemaVersion ?? TRANSCRIPT_SCHEMA_VERSION,
    runId: 'm0-canned-replay',
    seq: init.seq,
    tSim: 0,
    tWall: 0,
    kind: init.kind,
    payload: init.payload ?? {},
    contentClass: init.contentClass ?? 'contentFree',
  }
}

function grantedRecord(seq: number, grantId: string): TranscriptRecord {
  return makeRecord({
    seq,
    kind: 'turn.granted',
    payload: {
      grant: {
        turnId: 'turn-1',
        grantId,
        personaId: 'manager',
        expiresAt: '2026-06-01T12:00:00.000Z',
      },
    },
  })
}

function committedRecord(seq: number, grantId: string): TranscriptRecord {
  return makeRecord({
    seq,
    kind: 'persona.response.committed',
    payload: { grantId, text: 'Hello' },
    contentClass: 'restricted',
  })
}

function sessionStartedRecord(seq: number): TranscriptRecord {
  return makeRecord({
    seq,
    kind: 'session.started',
    payload: { sessionId: 'session-1', clockMode: 'simulated', lang: 'en' },
  })
}

function scoreFor(grades: readonly TrialGrade[], metric: string): Record<string, unknown> {
  const score = grades[0]?.scores.find((candidate) => candidate.metric === metric)
  if (score === undefined) throw new Error(`fixture grade has no ${metric} score`)
  return score as unknown as Record<string, unknown>
}

function metricValue(grades: readonly TrialGrade[], metric: string): unknown {
  return scoreFor(grades, metric).value
}

/** The exact record for `gradedTrial` with a two-record valid transcript. */
function gradedRecord(executionId = EN_EXECUTION_ID): TrialGrade {
  return {
    schemaVersion: '1.0.0',
    executionId,
    runId: 'm0-canned-replay',
    suite: 'm0-canned-replay',
    round: 0,
    taskId: EN_TASK,
    lang: 'en',
    trialId: EN_TRIAL_ID,
    task: {
      domain: 'workplace',
      scenarioType: 'request-deadline-extension',
      cefrBand: 'B1',
      split: 'calibration',
    },
    grader: { id: 'deterministic-invariants', kind: 'code', version: '1.0.0' },
    rubricVersion: 'm0-harness-v1',
    status: 'graded',
    scores: [
      { metric: 'trial.status', kind: 'categorical', value: 'graded', status: 'graded' },
      { metric: 'trial.ok', kind: 'boolean', value: true, status: 'graded' },
      { metric: 'transcript.schema_valid', kind: 'boolean', value: true, status: 'graded' },
      { metric: 'transcript.seq_monotonic', kind: 'boolean', value: true, status: 'graded' },
      { metric: 'transcript.content_class', kind: 'boolean', value: true, status: 'graded' },
      {
        metric: 'transcript.guard_violations',
        kind: 'numeric',
        value: 0,
        status: 'graded',
        evidence: 'no §3.2 guard violations',
      },
      { metric: 'trial.records', kind: 'numeric', value: 2, status: 'graded' },
      { metric: 'trial.sim_duration_ms', kind: 'numeric', value: 42, status: 'graded' },
    ],
  }
}

function detail(overrides: Partial<SemanticGrade> = {}): SemanticGrade {
  return {
    trialId: EN_TRIAL_ID,
    axis: 'plain_text',
    metric: 'response.plain_text_rate',
    question: 'Is the reply plain, unformatted text?',
    probability: 0.82,
    threshold: 0.5,
    distribution: { yes: 0.82, no: 0.18 },
    servedModel: 'typesafe/jev-1.14',
    cacheHit: false,
    ...overrides,
  }
}

interface SafeParser {
  safeParse(value: unknown): { readonly success: boolean }
}

function expectRejected(schema: SafeParser, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false)
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

  it('keeps the trial order and attaches the loaded task metadata per language', async () => {
    const execution = await run()
    const grades = buildGrades({ execution })

    expect(grades.records.map((record) => record.trialId)).toEqual(
      execution.result.trials.map((trial) => `${trial.round}:${trial.lang}:${trial.taskId}`),
    )

    for (const record of grades.records) {
      const loaded = execution.tasks.find(
        ({ task }) => task.lang === record.lang && task.id === record.taskId,
      )
      expect(loaded).toBeDefined()
      expect(record.task).toStrictEqual({
        domain: loaded?.task.domain,
        scenarioType: loaded?.task.scenarioType,
        cefrBand: loaded?.task.cefrBand,
        split: loaded?.task.split,
      })
    }
  })

  it('derives the execution id, or uses the override for every record', async () => {
    const execution = await run()

    const derived = buildGrades({ execution })
    expect(derived.executionId).toBe(EN_EXECUTION_ID)
    expect(derived.records.every((record) => record.executionId === EN_EXECUTION_ID)).toBe(true)

    const overridden = buildGrades({ execution, executionId: 'manual-execution-1' })
    expect(overridden.executionId).toBe('manual-execution-1')
    expect(overridden.records.every((record) => record.executionId === 'manual-execution-1')).toBe(
      true,
    )
    expect(overridden.jsonl).not.toBe(derived.jsonl)
  })

  it('fails with the exact message when the trial has no transcript', async () => {
    const execution = await base()
    const trial = gradedTrial(execution)
    const withoutTranscript: EvaluationRun = {
      ...executionWithTrial(execution, trial, []),
      transcripts: [],
    }

    expect(() => buildGrades({ execution: withoutTranscript })).toThrow(
      `cannot grade trial 0:en:${EN_TASK}: no transcript was produced`,
    )
  })

  it('fails with the exact message when no loaded task matches the trial language and id', async () => {
    const execution = await base()
    const trial: TrialOutcome = { ...gradedTrial(execution), lang: 'fr' }
    const mismatched = executionWithTrial(execution, trial, [sessionStartedRecord(0)])

    expect(() => buildGrades({ execution: mismatched })).toThrow(
      `cannot grade trial 0:fr:${EN_TASK}: no loaded task matches it`,
    )
  })

  it('builds the full graded record with the seven facts in metric order', async () => {
    const execution = await base()
    const trial = gradedTrial(execution)
    const records = [grantedRecord(0, 'grant-1'), committedRecord(1, 'grant-1')]

    const grades = buildGrades({ execution: executionWithTrial(execution, trial, records) })

    expect(grades.records).toStrictEqual([gradedRecord()])
  })

  it('takes the record count from the trial outcome, not the transcript length', async () => {
    const execution = await base()
    const trial: TrialOutcome = { ...gradedTrial(execution), records: 7 }
    const records = [grantedRecord(0, 'grant-1'), committedRecord(1, 'grant-1')]

    const grades = buildGrades({ execution: executionWithTrial(execution, trial, records) })

    expect(metricValue(grades.records, 'trial.records')).toBe(7)
  })

  it('omits trial.sim_duration_ms when the trial has no simulated duration', async () => {
    const execution = await base()
    const trial: TrialOutcome = { ...gradedTrial(execution), simDurationMs: undefined }
    const records = [grantedRecord(0, 'grant-1')]

    const grades = buildGrades({ execution: executionWithTrial(execution, trial, records) })

    expect(grades.records[0]?.scores.map((score) => score.metric)).toStrictEqual([
      'trial.status',
      'trial.ok',
      'transcript.schema_valid',
      'transcript.seq_monotonic',
      'transcript.content_class',
      'transcript.guard_violations',
      'trial.records',
    ])
  })

  it('records the grader model only when the grader names one', async () => {
    const execution = await base()
    const trial = gradedTrial(execution)
    const records = [grantedRecord(0, 'grant-1')]

    const semantic = buildGrades({
      execution: withGrader(executionWithTrial(execution, trial, records), {
        id: 'jev',
        kind: 'system-one-model',
        version: 'typesafe/jev-1.14',
        model: 'typesafe/jev-1.14',
      }),
    })
    expect(semantic.records[0]?.grader).toStrictEqual({
      id: 'jev',
      kind: 'system-one-model',
      version: 'typesafe/jev-1.14',
      model: 'typesafe/jev-1.14',
    })

    const human = buildGrades({
      execution: withGrader(executionWithTrial(execution, trial, records), {
        id: 'human-review',
        kind: 'human',
        version: 'v1',
      }),
    })
    expect(human.records[0]?.grader).toStrictEqual({
      id: 'human-review',
      kind: 'human',
      version: 'v1',
    })
    expect('model' in (human.records[0]?.grader ?? {})).toBe(false)
  })

  it('copies the rubric version from the manifest', async () => {
    const execution = await base()
    const trial = gradedTrial(execution)
    const records = [grantedRecord(0, 'grant-1')]

    const grades = buildGrades({
      execution: withRubricVersion(executionWithTrial(execution, trial, records), 'custom-v9'),
    })

    expect(grades.records[0]?.rubricVersion).toBe('custom-v9')
  })

  it('stores per-axis facts and evidence, with no composite score', async () => {
    const execution = await run()
    const [record] = buildGrades({ execution }).records
    expect(record).toBeDefined()

    const metrics = record?.scores.map((score) => score.metric)
    expect(metrics).toEqual([
      'trial.status',
      'trial.ok',
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
        'trial.provider_outage',
        'trial.status',
      ])
      const status = record.scores.find((score) => score.metric === 'trial.status')
      expect(status?.value).toBe('inconclusive')
      expect(status?.status).toBe('inconclusive')
      expect(record.scores.some((score) => score.metric === 'trial.ok')).toBe(false)
      expect(record.scores.some((score) => score.metric.startsWith('transcript.'))).toBe(false)
      expect(record.error).toContain('provider is down')
    }
  })
})

describe('buildGrades for failed trials', () => {
  it('marks a failed trial failed, with no outage score and no false value', async () => {
    const execution = await base()
    const trial: TrialOutcome = {
      ...gradedTrial(execution),
      ok: false,
      records: 0,
      providerOutage: false,
      simDurationMs: undefined,
    }

    const grades = buildGrades({ execution: executionWithTrial(execution, trial, []) })

    expect(grades.records).toStrictEqual([
      {
        ...gradedRecord(),
        status: 'failed',
        scores: [
          { metric: 'trial.status', kind: 'categorical', value: 'failed', status: 'graded' },
        ],
      },
    ])
    expect(grades.records[0]?.scores.some((score) => score.value === false)).toBe(false)
    expect(
      grades.records[0]?.scores.some((score) => score.metric === 'trial.provider_outage'),
    ).toBe(false)
  })

  it('keeps the trial error on a failed record, and omits it when absent', async () => {
    const execution = await base()
    const failed: TrialOutcome = {
      ...gradedTrial(execution),
      ok: false,
      records: 0,
      providerOutage: false,
      error: 'trial aborted: model returned no output',
    }

    const grades = buildGrades({ execution: executionWithTrial(execution, failed, []) })

    expect(grades.records[0]?.error).toBe('trial aborted: model returned no output')
    expect(grades.records[0]?.status).toBe('failed')
  })

  it('marks a provider outage inconclusive, with the outage flag only when true', async () => {
    const execution = await base()
    const outage: TrialOutcome = {
      ...gradedTrial(execution),
      ok: false,
      records: 0,
      providerOutage: true,
      simDurationMs: undefined,
      error: 'provider is down',
    }

    const grades = buildGrades({ execution: executionWithTrial(execution, outage, []) })

    expect(grades.records).toStrictEqual([
      {
        ...gradedRecord(),
        status: 'inconclusive',
        scores: [
          {
            metric: 'trial.status',
            kind: 'categorical',
            value: 'inconclusive',
            status: 'inconclusive',
          },
          { metric: 'trial.provider_outage', kind: 'boolean', value: true, status: 'graded' },
        ],
        error: 'provider is down',
      },
    ])
  })
})

describe('semantic grade merge', () => {
  async function singleTrial(): Promise<EvaluationRun> {
    const execution = await base()
    const trial = gradedTrial(execution)
    return executionWithTrial(execution, trial, [grantedRecord(0, 'grant-1')])
  }

  it('returns the records untouched when there are no semantic details', async () => {
    const execution = await singleTrial()

    expect(buildGrades({ execution: withGradeDetails(execution, []) }).records).toStrictEqual(
      buildGrades({ execution }).records,
    )
  })

  it('appends one numeric probability score with evidence and raw answer', async () => {
    const execution = await singleTrial()
    const grades = buildGrades({ execution: withGradeDetails(execution, [detail()]) })
    const record = grades.records[0]

    expect(record?.scores).toHaveLength(9)
    expect(record?.scores.slice(0, 8)).toStrictEqual(gradedRecord().scores.slice(0, 8))
    expect(record?.scores[8]).toStrictEqual({
      metric: 'response.plain_text_rate',
      kind: 'numeric',
      value: 0.82,
      status: 'graded',
      evidence: 'plain_text judged by typesafe/jev-1.14',
      raw: {
        question: 'Is the reply plain, unformatted text?',
        answer: 'yes',
        probability: 0.82,
        distribution: { yes: 0.82, no: 0.18 },
      },
    })
  })

  it('notes a cache hit in the evidence', async () => {
    const execution = await singleTrial()
    const grades = buildGrades({
      execution: withGradeDetails(execution, [detail({ cacheHit: true })]),
    })

    expect(scoreFor(grades.records, 'response.plain_text_rate').evidence).toBe(
      'plain_text judged by typesafe/jev-1.14 (cache hit)',
    )
  })

  it('maps the probability to yes at and above the threshold, and no below it', async () => {
    const execution = await singleTrial()
    const grades = buildGrades({
      execution: withGradeDetails(execution, [
        detail({
          metric: 'axis.at_threshold',
          axis: 'at_threshold',
          probability: 0.5,
          threshold: 0.5,
        }),
        detail({
          metric: 'axis.below_threshold',
          axis: 'below_threshold',
          probability: 0.499,
          threshold: 0.5,
        }),
      ]),
    })

    expect(scoreFor(grades.records, 'axis.at_threshold').raw).toMatchObject({ answer: 'yes' })
    expect(scoreFor(grades.records, 'axis.below_threshold').raw).toMatchObject({ answer: 'no' })
  })

  it('appends many details for one trial in detail order', async () => {
    const execution = await singleTrial()
    const grades = buildGrades({
      execution: withGradeDetails(execution, [
        detail({ metric: 'axis.first', axis: 'first' }),
        detail({ metric: 'axis.second', axis: 'second', probability: 0.2 }),
        detail({ metric: 'axis.first', axis: 'first', probability: 0.1 }),
      ]),
    })

    expect(grades.records[0]?.scores.slice(8).map((score) => score.metric)).toStrictEqual([
      'axis.first',
      'axis.second',
      'axis.first',
    ])
    expect(grades.records[0]?.scores.slice(8).map((score) => score.value)).toStrictEqual([
      0.82, 0.2, 0.1,
    ])
  })

  it('leaves a record untouched when no detail names its trial', async () => {
    const execution = await singleTrial()
    const grades = buildGrades({
      execution: withGradeDetails(execution, [detail({ trialId: '9:fr:unknown-task' })]),
    })

    expect(grades.records).toStrictEqual(buildGrades({ execution }).records)
  })

  it('appends every duplicate detail, without de-duplicating', async () => {
    const execution = await singleTrial()
    const grades = buildGrades({
      execution: withGradeDetails(execution, [detail(), detail()]),
    })

    expect(grades.records[0]?.scores).toHaveLength(10)
    expect(grades.records[0]?.scores[8]).toStrictEqual(grades.records[0]?.scores[9])
  })

  it('merges each trial in result order, not detail order', async () => {
    const execution = await base()
    const trials = execution.result.trials.slice(0, 2)
    const firstTrial = trials[0]
    const secondTrial = trials[1]
    if (firstTrial === undefined || secondTrial === undefined) throw new Error('missing trials')

    const wanted = new Set(trials.map((trial) => `${trial.round}:${trial.lang}:${trial.taskId}`))
    const twoTrials: EvaluationRun = {
      ...execution,
      result: { ...execution.result, trials },
      transcripts: execution.transcripts.filter((transcript) =>
        wanted.has(`${transcript.round}:${transcript.lang}:${transcript.taskId}`),
      ),
      gradeDetails: [
        detail({
          trialId: `${secondTrial.round}:${secondTrial.lang}:${secondTrial.taskId}`,
          metric: 'axis.second',
          axis: 'second',
        }),
        detail({
          trialId: `${firstTrial.round}:${firstTrial.lang}:${firstTrial.taskId}`,
          metric: 'axis.first',
          axis: 'first',
        }),
      ],
    }

    const grades = buildGrades({ execution: twoTrials })

    expect(grades.records.map((record) => record.trialId)).toStrictEqual([
      `${firstTrial.round}:${firstTrial.lang}:${firstTrial.taskId}`,
      `${secondTrial.round}:${secondTrial.lang}:${secondTrial.taskId}`,
    ])
    expect(grades.records[0]?.scores.at(-1)?.metric).toBe('axis.first')
    expect(grades.records[1]?.scores.at(-1)?.metric).toBe('axis.second')
  })
})

describe('trial facts derived from the transcript', () => {
  async function factsFor(records: readonly TranscriptRecord[]): Promise<TrialGrade> {
    const execution = await base()
    const grades = buildGrades({
      execution: executionWithTrial(execution, gradedTrial(execution), records),
    })
    const [record] = grades.records
    if (record === undefined) throw new Error('missing grade record')
    return record
  }

  it('accepts a valid transcript and reports every invariant true', async () => {
    const record = await factsFor([grantedRecord(0, 'grant-1'), committedRecord(1, 'grant-1')])

    expect(metricValue([record], 'transcript.schema_valid')).toBe(true)
    expect(metricValue([record], 'transcript.seq_monotonic')).toBe(true)
    expect(metricValue([record], 'transcript.content_class')).toBe(true)
    expect(metricValue([record], 'transcript.guard_violations')).toBe(0)
  })

  it('reports a schema-invalid record without failing the other invariants', async () => {
    const invalid = makeRecord({ seq: -1, kind: 'latency.sample' })

    const record = await factsFor([invalid])

    expect(metricValue([record], 'transcript.schema_valid')).toBe(false)
    expect(metricValue([record], 'transcript.seq_monotonic')).toBe(true)
    expect(metricValue([record], 'transcript.content_class')).toBe(false)
    expect(metricValue([record], 'transcript.guard_violations')).toBe(0)
  })

  it('reports a non-event record as a content-class failure and skips event conversion', async () => {
    const operational = makeRecord({ seq: 0, kind: 'latency.sample', payload: { ms: 12 } })

    const record = await factsFor([operational])

    expect(metricValue([record], 'transcript.schema_valid')).toBe(true)
    expect(metricValue([record], 'transcript.seq_monotonic')).toBe(true)
    expect(metricValue([record], 'transcript.content_class')).toBe(false)
    expect(metricValue([record], 'transcript.guard_violations')).toBe(0)
  })

  it('reports a content-class mismatch even when the record still parses', async () => {
    const mismatch = makeRecord({
      seq: 0,
      kind: 'turn.granted',
      payload: grantedRecord(0, 'grant-1').payload,
      contentClass: 'restricted',
      schemaVersion: '1.0.0',
    })

    const record = await factsFor([mismatch])

    expect(metricValue([record], 'transcript.schema_valid')).toBe(true)
    expect(metricValue([record], 'transcript.seq_monotonic')).toBe(true)
    expect(metricValue([record], 'transcript.content_class')).toBe(false)
    expect(metricValue([record], 'transcript.guard_violations')).toBe(0)
  })

  it('reports a non-monotonic transcript sequence', async () => {
    const record = await factsFor([sessionStartedRecord(3), sessionStartedRecord(2)])

    expect(metricValue([record], 'transcript.schema_valid')).toBe(true)
    expect(metricValue([record], 'transcript.seq_monotonic')).toBe(false)
    expect(metricValue([record], 'transcript.content_class')).toBe(true)
  })

  it('collects every guard violation across records into one evidence string', async () => {
    const record = await factsFor([
      grantedRecord(0, 'grant-1'),
      grantedRecord(1, 'grant-2'),
      grantedRecord(2, 'grant-3'),
    ])

    expect(metricValue([record], 'transcript.guard_violations')).toBe(2)
    expect(scoreFor([record], 'transcript.guard_violations').evidence).toBe(
      'grant_conflict: grant grant-2 issued while grant grant-1 is still current; ' +
        'grant_conflict: grant grant-3 issued while grant grant-1 is still current',
    )
  })

  it('selects the transcript by round, language and task id, ignoring decoys', async () => {
    const execution = await base()
    const trial = gradedTrial(execution)
    const source = firstTranscript(execution)
    const invalidRecord = makeRecord({ seq: -1, kind: 'latency.sample' })
    const validRecords = [grantedRecord(0, 'grant-1'), committedRecord(1, 'grant-1')]

    const withDecoys: EvaluationRun = {
      ...execution,
      result: { ...execution.result, trials: [trial] },
      transcripts: [
        {
          ...source,
          taskId: trial.taskId,
          lang: trial.lang,
          round: trial.round + 1,
          records: [invalidRecord],
        },
        {
          ...source,
          taskId: trial.taskId,
          lang: trial.lang === 'en' ? 'fr' : 'en',
          round: trial.round,
          records: [invalidRecord],
        },
        {
          ...source,
          taskId: 'some-other-task',
          lang: trial.lang,
          round: trial.round,
          records: [invalidRecord],
        },
        {
          ...source,
          taskId: trial.taskId,
          lang: trial.lang,
          round: trial.round,
          records: validRecords,
        },
      ],
    }

    const [record] = buildGrades({ execution: withDecoys }).records

    expect(record?.scores).toStrictEqual(gradedRecord().scores)
  })
})

describe('gradesJsonl', () => {
  it('returns an empty string for no records', () => {
    expect(gradesJsonl([])).toBe('')
  })

  it('writes one canonical JSON line per record with a trailing newline', async () => {
    const execution = await run()
    const { records } = buildGrades({ execution })
    const jsonl = gradesJsonl(records)

    expect(jsonl).toBe(`${records.map((record) => canonicalJson(record)).join('\n')}\n`)
    expect(jsonl.endsWith('\n')).toBe(true)
    expect(jsonl.trimEnd().split('\n')).toHaveLength(records.length)

    const lines = jsonl.trimEnd().split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const parsed: unknown = JSON.parse(line)
      expect(trialGradeSchema.parse(parsed)).toStrictEqual(parsed)
      expect(parsed).toStrictEqual(records[index])
    }

    const firstKeys = Object.keys(JSON.parse(lines[0] ?? '') as Record<string, unknown>)
    expect(firstKeys).toStrictEqual([...firstKeys].sort())
  })
})

describe('grade schemas', () => {
  const validScore = {
    metric: 'response.plain_text_rate',
    kind: 'boolean',
    value: true,
    status: 'graded',
    evidence: 'stream contained no Markdown',
    explanation: 'the response is plain text',
    raw: {
      question: 'Is the reply plain, unformatted text?',
      answer: 'yes',
      probability: 0.9,
      distribution: { yes: 0.9, no: 0.1 },
    },
  }

  it('publishes the exact status and value-kind vocabularies', () => {
    expect(GRADES_SCHEMA_VERSION).toBe('1.0.0')
    expect(gradeStatusSchema.options).toStrictEqual(['graded', 'failed', 'inconclusive'])
    expect(gradeValueKindSchema.options).toStrictEqual(['boolean', 'numeric', 'categorical'])
  })

  it('parses a valid trial grade and a valid score with every optional field', () => {
    expect(trialGradeSchema.parse(gradedRecord('manual-execution-1'))).toStrictEqual(
      gradedRecord('manual-execution-1'),
    )
    expect(gradeScoreSchema.parse(validScore)).toStrictEqual(validScore)
  })

  it('accepts every grader kind and rejects an unknown one', () => {
    const semantic = {
      ...gradedRecord(),
      grader: { id: 'jev', kind: 'system-one-model', version: 'v1', model: 'typesafe/jev-1.14' },
    }
    expect(trialGradeSchema.parse(semantic).grader.kind).toBe('system-one-model')

    const human = { ...gradedRecord(), grader: { id: 'human', kind: 'human', version: 'v1' } }
    expect(trialGradeSchema.parse(human).grader.kind).toBe('human')

    const unknown = { ...gradedRecord(), grader: { id: 'g', kind: 'llm', version: 'v1' } }
    expectRejected(trialGradeSchema, unknown)
  })

  it('rejects a trial grade with structural violations', () => {
    expectRejected(trialGradeSchema, { ...gradedRecord(), scores: [] })
    expectRejected(trialGradeSchema, { ...gradedRecord(), extra: true })
    expectRejected(trialGradeSchema, { ...gradedRecord(), status: 'skipped' })
    expectRejected(trialGradeSchema, { ...gradedRecord(), schemaVersion: '2.0.0' })
    expectRejected(trialGradeSchema, { ...gradedRecord(), executionId: '' })
    expectRejected(trialGradeSchema, { ...gradedRecord(), runId: '' })
    expectRejected(trialGradeSchema, { ...gradedRecord(), suite: '' })
    expectRejected(trialGradeSchema, { ...gradedRecord(), round: -1 })
    expectRejected(trialGradeSchema, { ...gradedRecord(), round: 0.5 })
    expectRejected(trialGradeSchema, { ...gradedRecord(), taskId: '' })
    expectRejected(trialGradeSchema, { ...gradedRecord(), lang: 'de' })
    expectRejected(trialGradeSchema, { ...gradedRecord(), trialId: '' })
    expectRejected(trialGradeSchema, { ...gradedRecord(), rubricVersion: '' })
    expectRejected(trialGradeSchema, { ...gradedRecord(), error: '' })
    expectRejected(trialGradeSchema, {
      ...gradedRecord(),
      task: { ...gradedRecord().task, domain: '' },
    })
    expectRejected(trialGradeSchema, {
      ...gradedRecord(),
      task: { ...gradedRecord().task, extra: true },
    })
    expectRejected(trialGradeSchema, {
      ...gradedRecord(),
      grader: { ...gradedRecord().grader, version: '' },
    })
    expectRejected(trialGradeSchema, {
      ...gradedRecord(),
      grader: { ...gradedRecord().grader, extra: true },
    })
  })

  it('rejects a score with an invalid kind, status or value', () => {
    expectRejected(gradeScoreSchema, { ...validScore, extra: true })
    expectRejected(gradeScoreSchema, { ...validScore, metric: '' })
    expectRejected(gradeScoreSchema, { ...validScore, kind: 'text' })
    expectRejected(gradeScoreSchema, { ...validScore, status: 'failed' })
    expectRejected(gradeScoreSchema, { ...validScore, value: '' })
    expectRejected(gradeScoreSchema, { ...validScore, value: {} })
    expectRejected(gradeScoreSchema, { ...validScore, value: null })
    expectRejected(gradeScoreSchema, { ...validScore, value: Number.POSITIVE_INFINITY })
    expectRejected(gradeScoreSchema, { ...validScore, value: Number.NaN })
    expectRejected(gradeScoreSchema, { ...validScore, evidence: '' })
    expectRejected(gradeScoreSchema, { ...validScore, explanation: '' })
  })

  it('rejects a raw grade outside the probability and text bounds', () => {
    expectRejected(gradeScoreSchema, { ...validScore, raw: { probability: -0.01 } })
    expectRejected(gradeScoreSchema, { ...validScore, raw: { probability: 1.01 } })
    expectRejected(gradeScoreSchema, {
      ...validScore,
      raw: { probability: Number.POSITIVE_INFINITY },
    })
    expectRejected(gradeScoreSchema, { ...validScore, raw: { question: '' } })
    expectRejected(gradeScoreSchema, { ...validScore, raw: { answer: '' } })
    expectRejected(gradeScoreSchema, { ...validScore, raw: { distribution: { '': 0.5 } } })
    expectRejected(gradeScoreSchema, {
      ...validScore,
      raw: { distribution: { yes: Number.POSITIVE_INFINITY } },
    })
    expectRejected(gradeScoreSchema, { ...validScore, raw: { extra: true } })
  })

  it('accepts raw grades at both probability boundaries', () => {
    expect(gradeScoreSchema.parse({ ...validScore, raw: { probability: 0 } })).toStrictEqual({
      ...validScore,
      raw: { probability: 0 },
    })
    expect(gradeScoreSchema.parse({ ...validScore, raw: { probability: 1 } })).toStrictEqual({
      ...validScore,
      raw: { probability: 1 },
    })
  })
})
