import type { TranscriptRecord } from '@rp/session-core'
import { REPLAY_PERSONA_MODEL, REPLAY_PERSONA_PROVIDER } from '../runner/replay.js'
import type { TaskEntry } from '../tasks/schema.js'
import type { ObservationEvent, ObservationSpan, ObservationTurn } from './plan.js'

/**
 * Transcript→trace folding for the observation plan (M0.1 D2).
 *
 * Folds one trial's transcript records into a span per turn, a generation per
 * persona response, and the readable dialogue a reviewer labels. Simulated
 * timestamps are kept as offsets; the adapter maps them to wall-clock dates at
 * export time. It makes no network calls and reads no clock.
 */

export class ObservationPlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ObservationPlanError'
  }
}

export interface TraceBuild {
  readonly events: readonly ObservationEvent[]
  readonly spans: readonly ObservationSpan[]
  readonly finalText?: string
  readonly conversation: readonly ObservationTurn[]
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
export function buildTrace(
  task: TaskEntry,
  records: readonly TranscriptRecord[],
  sessionProvider: string,
): TraceBuild {
  const spans: ObservationSpan[] = []
  const events: ObservationEvent[] = []
  const openGrants = new Map<string, number>()
  let lastTurnIndex = -1
  let persona: PersonaState | undefined
  let finalText: string | undefined
  const conversation: ObservationTurn[] = []
  const providerLabel = task.mode === 'session' ? sessionProvider : REPLAY_PERSONA_PROVIDER
  const modelLabel = task.mode === 'session' ? sessionProvider : REPLAY_PERSONA_MODEL

  const nextTurn = (role: 'user' | 'persona'): number => {
    // Session tasks store no replay turns: the transcript is the source of
    // truth, and turns alternate from the persona greeting onward.
    if (task.mode === 'session') {
      lastTurnIndex += 1
      return lastTurnIndex
    }
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
        conversation.push({ index: conversation.length, role: 'user', text })
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
            provider: providerLabel,
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
        conversation.push({ index: conversation.length, role: 'persona', text })
        spans.push({
          id: `generation-${persona.turnIndex}`,
          parentId: `turn-${persona.turnIndex}-persona`,
          name: `persona response ${persona.turnIndex}`,
          type: 'generation',
          startMs: persona.generationStartMs ?? atMs,
          endMs: atMs,
          input: requestMessages(task, persona.turnIndex),
          output: text,
          model: modelLabel,
          metadata: {
            provider: providerLabel,
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
          model: modelLabel,
          metadata: {
            provider: providerLabel,
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
    conversation,
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
