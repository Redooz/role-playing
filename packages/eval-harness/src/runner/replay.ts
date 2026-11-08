import { MemoryTranscriptSink, type Clock } from '@rp/shared'
import {
  TRANSCRIPT_SCHEMA_VERSION,
  expectedContentClass,
  normalizedTranscriptJsonl,
  type EventPayloadFor,
  type SessionEventName,
  type TranscriptRecord,
} from '@rp/session-core'
import type { TaskEntry } from '../tasks/schema.js'
import type {
  CannedEntry,
  CompletionChunk,
  CompletionMessage,
  CompletionProvider,
  CompletionRequest,
} from './canned-provider.js'
import { ReplayAbortedError } from './canned-provider.js'

/**
 * Deterministic task replay (M0 D3, gate G1).
 *
 * This is a **replay**, not arbitration behaviour. It replays one task by
 * emitting the §2.1 events a session would emit around a persona reply. It
 * makes no routing decisions, has no personas and no turn-taking policy: every
 * persona turn in the task is replayed through the injected provider port.
 *
 * Time comes only from the injected `Clock`; a `FakeClock` advances by fixed
 * delays so the same task always produces the same `tSim` values. Wall-clock
 * time is passed in explicitly and is removed by the normalized JSONL writer,
 * which is what makes two runs byte-identical (G1).
 */

/** The only provider surface the M0 replay exercises. */
export const REPLAY_PERSONA_PROVIDER = 'persona'
export const REPLAY_PERSONA_MODEL = 'canned/persona-v1'

/** Simulated lifetime of a replayed grant. Events in a replay finish well inside it. */
export const REPLAY_GRANT_TTL_MS = 60_000

/** Fixed simulated delays. They never read the wall clock. */
const INITIAL_DELAY_MS = 10
const TURN_GAP_MS = 250
const RESPONSE_START_MS = 40
const CHUNK_DELAY_MS = 20
const COMMIT_DELAY_MS = 30
const SESSION_END_MS = 200

/** How many whitespace-delimited words go into one streamed chunk. */
const WORDS_PER_CHUNK = 3

export interface ReplayOptions {
  readonly runId: string
  /** Unique identity of this execution; `runId` only names the suite. */
  readonly executionId: string
  readonly task: TaskEntry
  readonly clock: Clock
  readonly provider: CompletionProvider
  /** Wall-clock source used only for `tWall`; normalized away before comparison. */
  readonly wallNow: () => number
  /** Persona id used in the replayed grant. Defaults to `persona-1`. */
  readonly personaId?: string
  /** Override the simulated grant lifetime (tests). */
  readonly grantTtlMs?: number
  /** Cancels a replay that exceeded the trial budget. */
  readonly signal?: AbortSignal
}

export interface ReplayResult {
  readonly records: readonly TranscriptRecord[]
  /** Canonical, normalized JSONL used for byte-for-byte comparison. */
  readonly jsonl: string
  /** Number of provider calls the replay made. */
  readonly providerRequests: number
}

/** A replay invariant was violated (for example a grant expired mid-response). */
export class ReplayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplayError'
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ReplayAbortedError()
}

/**
 * Build the provider request for one persona turn. The same function is used to
 * pre-compute canned entries, so a recorded response is found by payload hash
 * without any positional shortcut.
 */
export function buildPersonaRequest(task: TaskEntry, turnIndex: number): CompletionRequest {
  const turn = task.content.turns[turnIndex]
  if (turn === undefined || turn.role !== 'persona') {
    throw new ReplayError(`task ${task.id} has no persona turn at index ${turnIndex}`)
  }

  const messages = task.content.turns.slice(0, turnIndex).map((earlier): CompletionMessage => ({
    role: earlier.role === 'user' ? 'user' : 'assistant',
    content: earlier.text,
  }))

  return {
    provider: REPLAY_PERSONA_PROVIDER,
    model: REPLAY_PERSONA_MODEL,
    messages,
    metadata: {
      taskId: task.id,
      lang: task.lang,
      turnIndex: String(turnIndex),
    },
  }
}

/** Recorded output for every persona turn in a task, keyed by payload hash. */
export function buildCannedEntriesForTask(task: TaskEntry): CannedEntry[] {
  const entries: CannedEntry[] = []

  for (const [index, turn] of task.content.turns.entries()) {
    if (turn.role !== 'persona') continue
    entries.push({
      request: buildPersonaRequest(task, index),
      chunks: chunkText(turn.text),
    })
  }

  return entries
}

/**
 * Replay one task into an append-only transcript.
 *
 * Event order per persona turn:
 * `turn.granted → persona.response.started → persona.response.chunk* →
 * persona.response.committed`. User turns emit `user.utterance.committed`; the
 * transcript ends with `session.completed`. This is the same vocabulary the
 * driver emits; empty chunks are skipped and do not advance the sequence.
 */
export async function replayTask(options: ReplayOptions): Promise<ReplayResult> {
  const { runId, executionId, task, clock, provider, wallNow, signal } = options
  const personaId = options.personaId ?? 'persona-1'
  const grantTtlMs = options.grantTtlMs ?? REPLAY_GRANT_TTL_MS

  if (signal?.aborted === true) throw new ReplayAbortedError()

  const sink = new MemoryTranscriptSink<TranscriptRecord>()
  let seq = 0
  let providerRequests = 0

  const append = <Name extends SessionEventName>(
    kind: Name,
    payload: EventPayloadFor<Name>,
  ): void => {
    sink.append({
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      runId,
      executionId,
      seq,
      tSim: clock.now(),
      tWall: wallNow(),
      kind,
      payload,
      contentClass: expectedContentClass(kind),
    })
    seq += 1
  }

  await clock.advance(INITIAL_DELAY_MS)

  for (const [turnIndex, turn] of task.content.turns.entries()) {
    await clock.advance(TURN_GAP_MS)

    if (turn.role === 'user') {
      append('user.utterance.committed', { text: turn.text })
      continue
    }

    const grantId = `${task.id}-grant-${turnIndex}`
    const grantedAt = clock.now()
    const expiresAtMs = grantedAt + grantTtlMs

    append('turn.granted', {
      grant: {
        turnId: `${task.id}-turn-${turnIndex}`,
        grantId,
        personaId,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    })

    await clock.advance(RESPONSE_START_MS)
    append('persona.response.started', { grantId })

    const request = buildPersonaRequest(task, turnIndex)
    providerRequests += 1

    let text = ''
    let sequence = 0
    let sawLast = false

    throwIfAborted(signal)

    for await (const chunk of provider.complete(request, { signal })) {
      throwIfAborted(signal)
      if (sawLast) {
        throw new ReplayError(`provider "${provider.label}" yielded a chunk after the final chunk`)
      }

      await clock.advance(CHUNK_DELAY_MS)

      if (clock.now() >= expiresAtMs) {
        throw new ReplayError(
          `grant ${grantId} expired before the response completed; a replay must fit its grant lifetime`,
        )
      }

      const chunkText = readChunkText(chunk, provider.label)
      if (chunkText.length > 0) {
        append('persona.response.chunk', { grantId, text: chunkText, sequence })
        text += chunkText
        sequence += 1
      }
      sawLast = chunk.done
    }

    if (!sawLast) {
      throw new ReplayError(
        `provider "${provider.label}" did not mark the last chunk for ${task.id}`,
      )
    }

    await clock.advance(COMMIT_DELAY_MS)
    append('persona.response.committed', { grantId, text })
  }

  await clock.advance(SESSION_END_MS)
  append('session.completed', {})

  const records = [...sink.records]
  return {
    records,
    jsonl: normalizedTranscriptJsonl(records),
    providerRequests,
  }
}

function readChunkText(chunk: CompletionChunk, providerLabel: string): string {
  if (typeof chunk.text !== 'string') {
    throw new ReplayError(`provider "${providerLabel}" yielded a chunk without text`)
  }
  return chunk.text
}

/**
 * Split text into deterministic word-group chunks that concatenate back to the
 * exact original string. Multi-byte text is preserved because the split is on
 * whitespace, not byte length.
 */
export function chunkText(text: string, wordsPerChunk = WORDS_PER_CHUNK): string[] {
  if (wordsPerChunk < 1) throw new RangeError(`wordsPerChunk must be at least 1: ${wordsPerChunk}`)

  const tokens = text.match(/\S+\s*/g)
  if (tokens === null || tokens.join('') !== text) return [text]

  const chunks: string[] = []
  for (let index = 0; index < tokens.length; index += wordsPerChunk) {
    chunks.push(tokens.slice(index, index + wordsPerChunk).join(''))
  }

  return chunks.length === 0 ? [text] : chunks
}
