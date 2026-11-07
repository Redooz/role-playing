import type { TranscriptRecord } from '@rp/session-core'
import { REPLAY_PERSONA_MODEL, REPLAY_PERSONA_PROVIDER } from '../runner/replay.js'
import type { EvaluationRun } from '../runner/runner.js'
import type { TrialOutcome } from '../runner/results.js'
import type { TaskEntry } from '../tasks/schema.js'
import { deriveExecutionId } from './execution-id.js'
import type { TrialGrade } from './grades.js'

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
}

export class ObservationPlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ObservationPlanError'
  }
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
    const transcript = transcripts.get(itemId)
    const expectedOutput = options.expectedOutputs?.get(`${trial.lang}:${trial.taskId}`)
    const trace = buildTrace(task, transcript?.records ?? [])

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
        turns: task.content.turns.map((turn, index) => ({
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
          }
        : {
            status: 'failed' as const,
            ...(trial.error === undefined ? {} : { error: trial.error }),
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
      scores: toObservationScores(grade),
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

interface TraceBuild {
  readonly events: readonly ObservationEvent[]
  readonly spans: readonly ObservationSpan[]
  readonly finalText?: string
}

interface PersonaState {
  readonly turnIndex: number
  readonly grantId: string
  readonly spanIndex: number
  generationStartMs?: number
  partialText: string
}

/**
 * Fold the transcript into spans. Simulated timestamps are kept as offsets;
 * the adapter maps them to wall-clock dates at export time.
 */
function buildTrace(task: TaskEntry, records: readonly TranscriptRecord[]): TraceBuild {
  const spans: ObservationSpan[] = []
  const events: ObservationEvent[] = []
  const openGrants = new Map<string, number>()
  let lastTurnIndex = -1
  let persona: PersonaState | undefined
  let finalText: string | undefined

  const nextTurn = (role: 'user' | 'persona'): number => {
    for (let index = lastTurnIndex + 1; index < task.content.turns.length; index += 1) {
      if (task.content.turns[index]?.role === role) {
        lastTurnIndex = index
        return index
      }
    }
    throw new ObservationPlanError(
      `transcript has a ${role} event that the task ${task.id} does not contain`,
    )
  }

  for (const record of records) {
    const atMs = record.tSim

    switch (record.kind) {
      case 'user.utterance.committed': {
        const index = nextTurn('user')
        const text = readText(record.payload)
        spans.push({
          id: `turn-${index}-user`,
          name: `turn ${index} user`,
          type: 'span',
          startMs: atMs,
          endMs: atMs,
          input: text,
          output: text,
          events: [],
        })
        break
      }

      case 'turn.granted': {
        const index = nextTurn('persona')
        const grant = readGrant(record.payload)
        spans.push({
          id: `turn-${index}-persona`,
          name: `turn ${index} persona`,
          type: 'span',
          startMs: atMs,
          endMs: atMs,
          metadata: {
            turnId: grant.turnId,
            personaId: grant.personaId,
            provider: REPLAY_PERSONA_PROVIDER,
          },
          events: [
            {
              name: 'turn.granted',
              atMs,
              attributes: {
                grantId: grant.grantId,
                turnId: grant.turnId,
                personaId: grant.personaId,
                expiresAt: grant.expiresAt,
              },
            },
          ],
        })
        openGrants.set(grant.grantId, spans.length - 1)
        persona = {
          turnIndex: index,
          grantId: grant.grantId,
          spanIndex: spans.length - 1,
          partialText: '',
        }
        break
      }

      case 'persona.response.started': {
        if (persona === undefined) break
        persona.generationStartMs = atMs
        break
      }

      case 'persona.response.chunk': {
        if (persona === undefined) break
        persona.partialText += readText(record.payload)
        break
      }

      case 'persona.response.committed': {
        if (persona === undefined) break
        const text = readText(record.payload)
        finalText = text
        spans.push({
          id: `generation-${persona.turnIndex}`,
          parentId: `turn-${persona.turnIndex}-persona`,
          name: `persona response ${persona.turnIndex}`,
          type: 'generation',
          startMs: persona.generationStartMs ?? atMs,
          endMs: atMs,
          input: requestMessages(task, persona.turnIndex),
          output: text,
          model: REPLAY_PERSONA_MODEL,
          metadata: {
            provider: REPLAY_PERSONA_PROVIDER,
            grantId: persona.grantId,
          },
          events: [],
        })
        closePersonaSpan(spans, persona, atMs)
        persona = undefined
        break
      }

      case 'persona.response.cancelled': {
        if (persona === undefined) break
        const reason = readReason(record.payload)
        const partialText = persona.partialText
        spans.push({
          id: `generation-${persona.turnIndex}`,
          parentId: `turn-${persona.turnIndex}-persona`,
          name: `persona response ${persona.turnIndex} (cancelled)`,
          type: 'generation',
          startMs: persona.generationStartMs ?? atMs,
          endMs: atMs,
          input: requestMessages(task, persona.turnIndex),
          ...(partialText === '' ? {} : { output: partialText }),
          model: REPLAY_PERSONA_MODEL,
          metadata: {
            provider: REPLAY_PERSONA_PROVIDER,
            grantId: persona.grantId,
            cancelled: true,
          },
          events: [],
        })
        addSpanEvent(spans, persona.spanIndex, {
          name: 'persona.response.cancelled',
          atMs,
          attributes: { grantId: persona.grantId, reason },
        })
        closePersonaSpan(spans, persona, atMs)
        persona = undefined
        break
      }

      case 'turn.revoked': {
        const reason = readReason(record.payload)
        const payload = record.payload as { readonly grantId?: unknown }
        const grantId = typeof payload.grantId === 'string' ? payload.grantId : undefined
        const spanIndex = grantId === undefined ? undefined : openGrants.get(grantId)

        if (spanIndex !== undefined) {
          addSpanEvent(spans, spanIndex, {
            name: 'turn.revoked',
            atMs,
            attributes: { grantId: grantId ?? '', reason },
          })
          closeSpan(spans, spanIndex, atMs)
          if (grantId !== undefined) openGrants.delete(grantId)
        } else if (persona !== undefined) {
          addSpanEvent(spans, persona.spanIndex, {
            name: 'turn.revoked',
            atMs,
            attributes: { grantId: persona.grantId, reason },
          })
          closePersonaSpan(spans, persona, atMs)
          openGrants.delete(persona.grantId)
          persona = undefined
        }
        break
      }

      case 'session.completed': {
        events.push({ name: 'session.completed', atMs, attributes: {} })
        break
      }

      default:
        break
    }
  }

  const lastAtMs = records.at(-1)?.tSim ?? 0
  for (const spanIndex of openGrants.values()) closeSpan(spans, spanIndex, lastAtMs)

  return {
    events,
    spans,
    ...(finalText === undefined ? {} : { finalText }),
  }
}

function closePersonaSpan(spans: ObservationSpan[], persona: PersonaState, atMs: number): void {
  closeSpan(spans, persona.spanIndex, atMs)
}

function closeSpan(spans: ObservationSpan[], spanIndex: number, atMs: number): void {
  const span = spans[spanIndex]
  if (span === undefined) return
  spans[spanIndex] = { ...span, endMs: Math.max(span.startMs, atMs) }
}

function addSpanEvent(spans: ObservationSpan[], spanIndex: number, event: ObservationEvent): void {
  const span = spans[spanIndex]
  if (span === undefined) return
  spans[spanIndex] = { ...span, events: [...span.events, event] }
}

function requestMessages(
  task: TaskEntry,
  turnIndex: number,
): readonly { readonly role: 'user' | 'assistant'; readonly content: string }[] {
  return task.content.turns.slice(0, turnIndex).map((turn) => ({
    role: turn.role === 'user' ? 'user' : 'assistant',
    content: turn.text,
  }))
}

function readText(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'text' in payload) {
    const text = (payload as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  throw new ObservationPlanError('transcript payload has no text field')
}

function readGrant(payload: unknown): {
  readonly grantId: string
  readonly turnId: string
  readonly personaId: string
  readonly expiresAt: string
} {
  if (typeof payload === 'object' && payload !== null && 'grant' in payload) {
    const grant = (payload as { grant?: unknown }).grant
    if (typeof grant === 'object' && grant !== null) {
      const record = grant as Record<string, unknown>
      if (
        typeof record['grantId'] === 'string' &&
        typeof record['turnId'] === 'string' &&
        typeof record['personaId'] === 'string' &&
        typeof record['expiresAt'] === 'string'
      ) {
        return {
          grantId: record['grantId'],
          turnId: record['turnId'],
          personaId: record['personaId'],
          expiresAt: record['expiresAt'],
        }
      }
    }
  }
  throw new ObservationPlanError('turn.granted payload has no complete grant')
}

function readReason(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'reason' in payload) {
    const reason = (payload as { reason?: unknown }).reason
    if (typeof reason === 'string') return reason
  }
  return 'unknown'
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
