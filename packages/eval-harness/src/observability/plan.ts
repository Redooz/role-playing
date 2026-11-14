import type { TranscriptRecord } from '@rp/session-core'
import type { EvaluationRun } from '../runner/runner.js'
import type { TrialOutcome } from '../runner/results.js'
import type { TaskEntry } from '../tasks/schema.js'
import { deriveExecutionId } from './execution-id.js'
import type { TrialGrade } from './grades.js'
import { buildTrace, ObservationPlanError } from './trace.js'

export { ObservationPlanError } from './trace.js'

/**
 * Pure observation plan (M0.1 D2).
 *
 * This is the boundary between the evaluation harness and any review platform.
 * It contains no Langfuse types and makes no network calls: the same
 * `EvaluationRun` + grades always produce the same plan, which is what lets the
 * mapper be golden-tested offline.
 *
 * One plan = one experiment = one execution.
 * One item = one trial (`round:lang:taskId`).
 * One item trace = the trial, with a span per turn and a generation per
 * provider call, plus the per-axis scores.
 */

export const OBSERVATION_PLAN_SCHEMA_VERSION = '1.0.0'

export type ObservationScoreDataType = 'NUMERIC' | 'BOOLEAN' | 'CATEGORICAL'

export interface ObservationScore {
  readonly name: string
  readonly value: number | string
  readonly dataType: ObservationScoreDataType
  readonly comment?: string
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface ObservationEvent {
  readonly name: string
  /** Simulated time in milliseconds from the start of the trial. */
  readonly atMs: number
  readonly attributes: Readonly<Record<string, string | number | boolean>>
}

export interface ObservationSpan {
  /** Stable within the item; the adapter derives the OTel span. */
  readonly id: string
  /** Another span id in the same item, or omitted for a root-level span. */
  readonly parentId?: string
  readonly name: string
  readonly type: 'span' | 'generation'
  readonly startMs: number
  readonly endMs: number
  readonly input?: unknown
  readonly output?: unknown
  readonly model?: string
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
  readonly events: readonly ObservationEvent[]
}

export interface ObservationTurn {
  readonly index: number
  readonly role: 'user' | 'persona'
  readonly text: string
}

export interface ObservationItem {
  readonly itemId: string
  readonly trialId: string
  readonly round: number
  readonly lang: 'en' | 'fr'
  readonly taskId: string
  readonly input: {
    readonly scenarioBrief?: string
    readonly turns: readonly ObservationTurn[]
  }
  readonly expectedOutput?: unknown
  readonly output: {
    readonly status: 'completed' | 'failed'
    readonly finalText?: string
    /** Full user/persona dialogue in transcript order, for review and labelling. */
    readonly conversation?: readonly ObservationTurn[]
    /** Readable rendering of the same dialogue. */
    readonly transcript?: string
    readonly error?: string
  }
  readonly metadata: Readonly<Record<string, string | number | boolean>>
  readonly trace: {
    readonly name: string
    readonly events: readonly ObservationEvent[]
    readonly spans: readonly ObservationSpan[]
  }
  readonly scores: readonly ObservationScore[]
}

export interface ObservationPlan {
  readonly schemaVersion: typeof OBSERVATION_PLAN_SCHEMA_VERSION
  readonly executionId: string
  readonly runId: string
  readonly suite: string
  readonly environment: 'experiment'
  readonly dataset: { readonly name: string; readonly version: string }
  readonly experiment: {
    readonly id: string
    readonly name: string
    readonly description?: string
    readonly metadata: Readonly<Record<string, string | number | boolean>>
  }
  readonly items: readonly ObservationItem[]
}

export interface BuildObservationPlanOptions {
  readonly execution: EvaluationRun
  /** Per-trial grades from {@link buildGrades}. */
  readonly grades: readonly TrialGrade[]
  /** Override the derived execution id (tests). */
  readonly executionId?: string
  /**
   * Golden reference per `${lang}:${taskId}`. Optional: M0 has golden labels for
   * only two tasks and the plan must still be complete without them.
   */
  readonly expectedOutputs?: ReadonlyMap<string, unknown>
  /**
   * Include the automated scores on each item. A blind human-labelling export
   * sets this to `false` so annotators cannot see the model's answers.
   */
  readonly includeScores?: boolean
}

/** Map a run and its grades to the platform-neutral observation plan. */
export function buildObservationPlan(options: BuildObservationPlanOptions): ObservationPlan {
  const { execution, grades } = options
  const { result } = execution
  const executionId = options.executionId ?? deriveExecutionId(result.runId, result.startedAt)

  const tasks = taskIndex(execution)
  const transcripts = transcriptIndex(execution)
  const gradeByTrial = new Map(grades.map((grade) => [grade.trialId, grade]))

  const items = result.trials.map((trial) => {
    const itemId = `${trial.round}:${trial.lang}:${trial.taskId}`
    const grade = gradeByTrial.get(itemId)
    if (grade === undefined) {
      throw new ObservationPlanError(`no grade record for trial ${itemId}`)
    }
    if (grade.executionId !== executionId) {
      throw new ObservationPlanError(
        `grade record ${itemId} belongs to execution ${grade.executionId}, not ${executionId}`,
      )
    }

    const task = requireTask(tasks, trial)
    const transcriptFile = transcripts.get(itemId)
    const expectedOutput = options.expectedOutputs?.get(`${trial.lang}:${trial.taskId}`)
    const trace = buildTrace(task, transcriptFile?.records ?? [], result.manifest.provider.label)
    const readableTranscript = trace.conversation
      .map((turn) => `${turn.role === 'persona' ? 'Persona' : 'Learner'}: ${turn.text}`)
      .join('\n')

    return {
      itemId,
      trialId: itemId,
      round: trial.round,
      lang: trial.lang,
      taskId: trial.taskId,
      input: {
        ...(task.content.scenarioBrief === undefined
          ? {}
          : { scenarioBrief: task.content.scenarioBrief }),
        turns:
          task.mode === 'session' && task.session !== undefined
            ? task.session.scriptedUserTurns.map((text, index) => ({
                index,
                role: 'user' as const,
                text,
              }))
            : task.content.turns.map((turn, index) => ({
                index,
                role: turn.role,
                text: turn.text,
              })),
      },
      ...(expectedOutput === undefined ? {} : { expectedOutput }),
      output: trial.ok
        ? {
            status: 'completed' as const,
            ...(trace.finalText === undefined ? {} : { finalText: trace.finalText }),
            ...(trace.conversation.length === 0
              ? {}
              : {
                  conversation: trace.conversation,
                  transcript: readableTranscript,
                }),
          }
        : {
            status: 'failed' as const,
            ...(trial.error === undefined ? {} : { error: trial.error }),
            ...(trace.conversation.length === 0
              ? {}
              : {
                  conversation: trace.conversation,
                  transcript: readableTranscript,
                }),
          },
      metadata: {
        round: trial.round,
        lang: trial.lang,
        taskId: trial.taskId,
        cefrBand: task.cefrBand,
        domain: task.domain,
        scenarioType: task.scenarioType,
        split: task.split,
        providerMode: result.manifest.provider.mode,
        providerLabel: result.manifest.provider.label,
        graderId: result.manifest.grader.id,
        graderVersion: result.manifest.grader.version,
        rubricVersion: result.manifest.rubric.version,
        verdict: result.verdict.status,
        ...(trial.transcriptPath === undefined ? {} : { transcriptPath: trial.transcriptPath }),
        ...(trial.transcriptSha256 === undefined
          ? {}
          : { transcriptSha256: trial.transcriptSha256 }),
      },
      trace: {
        name: itemId,
        events: trace.events,
        spans: trace.spans,
      },
      scores: options.includeScores === false ? [] : toObservationScores(grade),
    }
  })

  const manifest = result.manifest
  return {
    schemaVersion: OBSERVATION_PLAN_SCHEMA_VERSION,
    executionId,
    runId: result.runId,
    suite: result.suite,
    environment: 'experiment',
    dataset: { name: manifest.tasks.dataset, version: manifest.tasks.version },
    experiment: {
      id: executionId,
      name: `${result.suite} ${result.startedAt}`,
      ...(manifest.run.description === undefined ? {} : { description: manifest.run.description }),
      metadata: {
        runId: result.runId,
        suite: result.suite,
        purpose: manifest.run.purpose,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        manifestHash: result.manifestHash,
        verdict: result.verdict.status,
        seed: manifest.seeds.master,
        rounds: manifest.limits.rounds,
        ...(result.versions.codeSha === undefined ? {} : { codeSha: result.versions.codeSha }),
      },
    },
    items,
  }
}

/** Map grades to Langfuse-compatible scores. No composite score is created. */
export function toObservationScores(grade: TrialGrade): ObservationScore[] {
  return grade.scores.map((score) => ({
    name: score.metric,
    value:
      score.kind === 'boolean'
        ? (score.value as boolean)
          ? 1
          : 0
        : (score.value as number | string),
    dataType:
      score.kind === 'boolean' ? 'BOOLEAN' : score.kind === 'numeric' ? 'NUMERIC' : 'CATEGORICAL',
    ...(score.explanation === undefined && score.evidence === undefined
      ? {}
      : { comment: score.explanation ?? score.evidence }),
    metadata: {
      status: score.status,
      kind: score.kind,
      graderId: grade.grader.id,
      graderKind: grade.grader.kind,
      graderVersion: grade.grader.version,
      ...(grade.grader.model === undefined ? {} : { graderModel: grade.grader.model }),
      rubricVersion: grade.rubricVersion,
      ...(score.evidence === undefined ? {} : { evidence: score.evidence }),
      ...(score.explanation === undefined ? {} : { explanation: score.explanation }),
      ...(score.raw === undefined ? {} : { raw: score.raw }),
    },
  }))
}

function taskIndex(execution: EvaluationRun): Map<string, TaskEntry> {
  const index = new Map<string, TaskEntry>()
  for (const { task } of execution.tasks) index.set(`${task.lang}\u0000${task.id}`, task)
  return index
}

function transcriptIndex(
  execution: EvaluationRun,
): Map<string, { readonly records: readonly TranscriptRecord[] }> {
  const index = new Map<string, { readonly records: readonly TranscriptRecord[] }>()
  for (const transcript of execution.transcripts) {
    index.set(`${transcript.round}:${transcript.lang}:${transcript.taskId}`, transcript)
  }
  return index
}

function requireTask(index: Map<string, TaskEntry>, trial: TrialOutcome): TaskEntry {
  const task = index.get(`${trial.lang}\u0000${trial.taskId}`)
  if (task === undefined) {
    throw new ObservationPlanError(
      `no loaded task matches trial ${trial.round}:${trial.lang}:${trial.taskId}`,
    )
  }
  return task
}
