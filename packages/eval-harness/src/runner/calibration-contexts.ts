import { buildSessionRoutingContext, personaById } from '@rp/persona-kit'
import { scenarioById } from '@rp/scenario-kit'
import {
  eventFromTranscriptRecord,
  parseTranscriptRecord,
  type SessionEvent,
} from '@rp/session-core'
import type { GoldenEntry, SpeakerLabel, TaskEntry } from '../tasks/schema.js'
import type { RoutingComparisonTask } from './routing-comparison.js'

/**
 * Rebuild offline routing contexts from a recorded session history (M3d D3).
 *
 * A routing decision needs the conversation up to one committed learner turn.
 * The recorded session log has that history, so the same transcript can be
 * replayed against any routing arm without calling a persona model again.
 * Labels come from the golden entry; they never enter the context.
 */

export interface HistoryTurn {
  readonly role: 'user' | 'assistant'
  readonly content: string
  /** Present on an assistant turn in a multi-persona session. */
  readonly personaId?: string
}

export interface SessionHistory {
  /** Committed turns in emission order. */
  readonly turns: readonly HistoryTurn[]
  /** Turn opened after each learner turn; the decision that turn needs. */
  readonly decisionTurnIds: readonly string[]
}

/**
 * Read a saved eval transcript (one `TranscriptRecord` per line) as events.
 *
 * The eval result files are normalized records without the session-log header,
 * so `parseSessionLog` does not apply. Operational records that carry no event
 * are dropped, exactly as replay does.
 */
export function eventsFromTranscriptJsonl(text: string): readonly SessionEvent[] {
  const events: SessionEvent[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const event = eventFromTranscriptRecord(parseTranscriptRecord(JSON.parse(line)))
    if (event !== undefined) events.push(event)
  }
  return events
}

export class CalibrationHistoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CalibrationHistoryError'
  }
}

function personaIdOfGrant(events: readonly SessionEvent[]): ReadonlyMap<string, string> {
  const grants = new Map<string, string>()
  for (const event of events) {
    if (event.type !== 'turn.granted') continue
    grants.set(event.payload.grant.grantId, event.payload.grant.personaId)
  }
  return grants
}

/**
 * Read the committed conversation and the decision turn of each learner turn.
 *
 * A learner turn with no following `turn.opened` has no routing decision and is
 * dropped from `decisionTurnIds`; the caller rejects the resulting count
 * mismatch instead of inventing a turn.
 */
export function sessionHistoryFromEvents(events: readonly SessionEvent[]): SessionHistory {
  const grants = personaIdOfGrant(events)
  const turns: HistoryTurn[] = []
  const openings: string[] = []

  for (const event of events) {
    if (event.type === 'persona.response.committed') {
      turns.push({
        role: 'assistant',
        content: event.payload.text,
        personaId: grants.get(event.payload.grantId),
      })
      continue
    }
    if (event.type === 'user.utterance.committed') {
      turns.push({ role: 'user', content: event.payload.text })
      continue
    }
    if (event.type === 'turn.opened') openings.push(event.payload.turnId)
  }

  // The greeting opens the first turn before any learner turn; every later
  // opening is the decision turn of the learner turn before it.
  return { turns, decisionTurnIds: openings.slice(1) }
}

/** The learner turns in order, each already known to be followed by a decision. */
function userTurnIndexes(turns: readonly HistoryTurn[]): readonly number[] {
  const indexes: number[] = []
  turns.forEach((turn, index) => {
    if (turn.role === 'user') indexes.push(index)
  })
  return indexes
}

function labelFor(label: SpeakerLabel, scenarioId: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    intent: scenarioId,
    acceptablePersonaIds: [...label.acceptablePersonaIds],
    allowUserYield: label.allowUserYield,
    labelSource: label.labelSource,
    family: label.family ?? 'unlabelled',
  }
  if (label.distractor !== undefined) payload['distractor'] = label.distractor
  return payload
}

/**
 * Build one routing task per labelled learner turn.
 *
 * The golden entry must have one label per committed learner turn: a mismatch is
 * a data error, never a reason to pair a context with the wrong label.
 */
export function calibrationTasks(
  task: TaskEntry,
  golden: GoldenEntry,
  history: SessionHistory,
): RoutingComparisonTask[] {
  const session = task.session
  if (session === undefined) {
    throw new CalibrationHistoryError(`task ${task.id} is not a session task`)
  }
  const labels = golden.speakerLabels
  if (labels === undefined || labels.length === 0) {
    throw new CalibrationHistoryError(`golden ${golden.id} has no speaker labels`)
  }

  const personaIds = session.personaIds
  if (personaIds === undefined || personaIds.length === 0) {
    throw new CalibrationHistoryError(`task ${task.id} is not a multi-persona session task`)
  }

  const indexes = userTurnIndexes(history.turns)
  if (indexes.length !== history.decisionTurnIds.length) {
    throw new CalibrationHistoryError(
      `task ${task.id} has ${indexes.length} learner turns but ${history.decisionTurnIds.length} decision turns`,
    )
  }
  if (labels.length !== indexes.length) {
    throw new CalibrationHistoryError(
      `golden ${golden.id} has ${labels.length} labels for ${indexes.length} learner turns`,
    )
  }

  const locale = task.locale ?? task.lang
  const personas = personaIds.map((personaId) => personaById(personaId))
  const scenario = scenarioById(session.scenarioId)

  return indexes.map((turnIndex, position) => {
    const turnId = history.decisionTurnIds[position]!
    const label = labels[position]!
    const context = buildSessionRoutingContext({
      turnId,
      personas,
      scenario,
      locale,
      messages: history.turns.slice(0, turnIndex + 1).map((turn) => ({
        role: turn.role,
        content: turn.content,
        personaId: turn.personaId,
      })),
    })
    return {
      taskId: `${task.id}:${turnId}`,
      lang: task.lang,
      context,
      label: labelFor(label, session.scenarioId),
    }
  })
}
