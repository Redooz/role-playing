import { canonicalJson } from '@rp/shared'
import {
  checkTranscriptSequence,
  eventFromTranscriptRecord,
  guardTurnEvents,
  isSessionEventName,
  transcriptRecordSchema,
  type SessionEvent,
} from '@rp/session-core'
import { z } from 'zod'
import { expectedContentClass } from '../runner/replay.js'
import type { EvaluationRun, TrialTranscriptFile } from '../runner/runner.js'
import type { TrialOutcome } from '../runner/results.js'
import type { TaskEntry } from '../tasks/schema.js'
import { deriveExecutionId } from './execution-id.js'

/**
 * Raw per-trial grades (M0.1 D3).
 *
 * `result.json` keeps run-level metrics. This sidecar is the per-trial audit
 * copy of what the grader said, with enough detail to decide whether the agent
 * or the grader was wrong:
 *
 * - the exact metric and value;
 * - the raw answer/probability when a model produced one;
 * - the evidence and explanation;
 * - the grader and rubric versions.
 *
 * A failed trial is never turned into a zero. Its status is `failed`, or
 * `inconclusive` when a provider outage means the judgement has no evidence.
 */

export const GRADES_SCHEMA_VERSION = '1.0.0'

export const gradeStatusSchema = z.enum(['graded', 'failed', 'inconclusive'])
export type GradeStatus = z.infer<typeof gradeStatusSchema>

export const gradeValueKindSchema = z.enum(['boolean', 'numeric', 'categorical'])
export type GradeValueKind = z.infer<typeof gradeValueKindSchema>

const rawGradeSchema = z.strictObject({
  /** The exact question asked, when a model answered it. */
  question: z.string().min(1).optional(),
  /** The extracted answer, before any label mapping. */
  answer: z.string().min(1).optional(),
  /** Probability of the chosen answer, in [0, 1], for a System One model. */
  probability: z.number().finite().min(0).max(1).optional(),
  /** Full answer distribution, so a reviewer can see near-misses. */
  distribution: z.record(z.string().min(1), z.number().finite()).optional(),
})

export type RawGrade = z.infer<typeof rawGradeSchema>

export const gradeScoreSchema = z.strictObject({
  metric: z.string().min(1),
  kind: gradeValueKindSchema,
  value: z.union([z.boolean(), z.number().finite(), z.string().min(1)]),
  status: z.enum(['graded', 'inconclusive']),
  evidence: z.string().min(1).optional(),
  explanation: z.string().min(1).optional(),
  raw: rawGradeSchema.optional(),
})

export type GradeScore = z.infer<typeof gradeScoreSchema>

export const trialGradeSchema = z.strictObject({
  schemaVersion: z.literal(GRADES_SCHEMA_VERSION),
  executionId: z.string().min(1),
  runId: z.string().min(1),
  suite: z.string().min(1),
  round: z.int().nonnegative(),
  taskId: z.string().min(1),
  lang: z.enum(['en', 'fr']),
  trialId: z.string().min(1),
  task: z.strictObject({
    domain: z.string().min(1),
    scenarioType: z.string().min(1),
    cefrBand: z.string().min(1),
    split: z.string().min(1),
  }),
  grader: z.strictObject({
    id: z.string().min(1),
    kind: z.enum(['code', 'system-one-model', 'human']),
    version: z.string().min(1),
    model: z.string().min(1).optional(),
  }),
  rubricVersion: z.string().min(1),
  status: gradeStatusSchema,
  scores: z.array(gradeScoreSchema).min(1),
  error: z.string().min(1).optional(),
})

export type TrialGrade = z.infer<typeof trialGradeSchema>

export interface BuildGradesOptions {
  readonly execution: EvaluationRun
  /** Override the derived execution id (tests). */
  readonly executionId?: string
}

export interface GradesArtifact {
  readonly executionId: string
  readonly records: readonly TrialGrade[]
  readonly jsonl: string
}

/** Build every per-trial grade record, ordered like `result.trials`. */
export function buildGrades(options: BuildGradesOptions): GradesArtifact {
  const { execution } = options
  const executionId =
    options.executionId ?? deriveExecutionId(execution.result.runId, execution.result.startedAt)
  const tasks = taskIndex(execution)

  const records = execution.result.trials.map((trial) =>
    buildTrialGrade({ execution, executionId, trial, task: requireTask(tasks, trial) }),
  )

  return {
    executionId,
    records,
    jsonl: gradesJsonl(records),
  }
}

export function gradesJsonl(records: readonly TrialGrade[]): string {
  if (records.length === 0) return ''
  const lines = records.map((record) => canonicalJson(trialGradeSchema.parse(record)))
  return `${lines.join('\n')}\n`
}

interface BuildTrialGradeOptions {
  readonly execution: EvaluationRun
  readonly executionId: string
  readonly trial: TrialOutcome
  readonly task: TaskEntry
}

function buildTrialGrade(options: BuildTrialGradeOptions): TrialGrade {
  const { execution, executionId, trial, task } = options
  const { result } = execution
  const grader = result.manifest.grader

  const base = {
    schemaVersion: GRADES_SCHEMA_VERSION,
    executionId,
    runId: result.runId,
    suite: result.suite,
    round: trial.round,
    taskId: trial.taskId,
    lang: trial.lang,
    trialId: `${trial.round}:${trial.lang}:${trial.taskId}`,
    task: {
      domain: task.domain,
      scenarioType: task.scenarioType,
      cefrBand: task.cefrBand,
      split: task.split,
    },
    grader: {
      id: grader.id,
      kind: grader.kind,
      version: grader.version,
      ...(grader.model === undefined ? {} : { model: grader.model }),
    },
    rubricVersion: result.manifest.rubric.version,
  } as const

  if (!trial.ok) {
    // A failed trial has no quality reading. Never emit a `false` boolean that a
    // review platform would display as a zero: the categorical status carries
    // the outcome, and the outage flag is only present when it is true.
    return trialGradeSchema.parse({
      ...base,
      status: trial.providerOutage ? 'inconclusive' : 'failed',
      scores: [
        {
          metric: 'trial.status',
          kind: 'categorical',
          value: trial.providerOutage ? 'inconclusive' : 'failed',
          status: trial.providerOutage ? 'inconclusive' : 'graded',
        },
        ...(trial.providerOutage
          ? [
              {
                metric: 'trial.provider_outage',
                kind: 'boolean' as const,
                value: true,
                status: 'graded' as const,
              },
            ]
          : []),
      ],
      ...(trial.error === undefined ? {} : { error: trial.error }),
    })
  }

  const facts = trialFacts(execution, trial)

  const scores: GradeScore[] = [
    { metric: 'trial.status', kind: 'categorical', value: 'graded', status: 'graded' },
    // Only true booleans are emitted. `provider_outage = false` would render
    // as a zero and is implied by a graded trial.
    { metric: 'trial.ok', kind: 'boolean', value: true, status: 'graded' },
    {
      metric: 'transcript.schema_valid',
      kind: 'boolean',
      value: facts.schemaValid,
      status: 'graded',
    },
    {
      metric: 'transcript.seq_monotonic',
      kind: 'boolean',
      value: facts.sequenceValid,
      status: 'graded',
    },
    {
      metric: 'transcript.content_class',
      kind: 'boolean',
      value: facts.contentClassValid,
      status: 'graded',
    },
    {
      metric: 'transcript.guard_violations',
      kind: 'numeric',
      value: facts.violations.length,
      status: 'graded',
      evidence:
        facts.violations.length === 0
          ? 'no §3.2 guard violations'
          : facts.violations
              .map((violation) => `${violation.code}: ${violation.message}`)
              .join('; '),
    },
    {
      metric: 'trial.records',
      kind: 'numeric',
      value: trial.records,
      status: 'graded',
    },
    ...(trial.simDurationMs === undefined
      ? []
      : [
          {
            metric: 'trial.sim_duration_ms',
            kind: 'numeric' as const,
            value: trial.simDurationMs,
            status: 'graded' as const,
          },
        ]),
  ]

  return trialGradeSchema.parse({ ...base, status: 'graded', scores })
}

interface TrialFacts {
  readonly schemaValid: boolean
  readonly sequenceValid: boolean
  readonly contentClassValid: boolean
  readonly violations: readonly { readonly code: string; readonly message: string }[]
}

/**
 * Re-derive the per-trial invariants from the transcript in code. The run-level
 * `result.json` keeps ratios; a grade record needs the per-trial facts, and
 * recomputing them here keeps the sidecar honest if either file is inspected
 * alone.
 */
function trialFacts(execution: EvaluationRun, trial: TrialOutcome): TrialFacts {
  const transcript = requireTranscript(execution, trial)
  let schemaValid = true
  let contentClassValid = true
  const events: SessionEvent[] = []

  for (const record of transcript.records) {
    if (!transcriptRecordSchema.safeParse(record).success) schemaValid = false

    if (!isSessionEventName(record.kind)) {
      contentClassValid = false
      continue
    }

    if (record.contentClass !== expectedContentClass(record.kind)) contentClassValid = false

    const event = eventFromTranscriptRecord(record)
    if (event !== undefined) events.push(event)
  }

  const sequence = checkTranscriptSequence(transcript.records)
  const guard = guardTurnEvents(events)

  return {
    schemaValid,
    sequenceValid: sequence.ok,
    contentClassValid,
    violations: guard.violations,
  }
}

function requireTranscript(execution: EvaluationRun, trial: TrialOutcome): TrialTranscriptFile {
  const transcript = execution.transcripts.find(
    (candidate) =>
      candidate.round === trial.round &&
      candidate.lang === trial.lang &&
      candidate.taskId === trial.taskId,
  )
  if (transcript === undefined) {
    throw new Error(
      `cannot grade trial ${trial.round}:${trial.lang}:${trial.taskId}: no transcript was produced`,
    )
  }
  return transcript
}

function taskIndex(execution: EvaluationRun): Map<string, TaskEntry> {
  const index = new Map<string, TaskEntry>()
  for (const { task } of execution.tasks) index.set(`${task.lang}\u0000${task.id}`, task)
  return index
}

function requireTask(index: Map<string, TaskEntry>, trial: TrialOutcome): TaskEntry {
  const task = index.get(`${trial.lang}\u0000${trial.taskId}`)
  if (task === undefined) {
    throw new Error(
      `cannot grade trial ${trial.round}:${trial.lang}:${trial.taskId}: no loaded task matches it`,
    )
  }
  return task
}
