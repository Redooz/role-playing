import { canonicalJson } from '@rp/shared'
import { z } from 'zod'
import { clockModeSchema, sessionLanguageSchema, type SessionEvent } from './events.js'
import {
  eventFromTranscriptRecord,
  expectedContentClass,
  normalizedTranscriptJsonl,
  parseTranscriptRecord,
  TranscriptSchemaVersionError,
  type TranscriptRecord,
} from './transcript.js'
import {
  TRANSCRIPT_SCHEMA_VERSION,
  majorOfSchemaVersion,
  transcriptSchemaVersionSchema,
} from './version.js'

/**
 * Append-only session log (M1 D3).
 *
 * The first line is a header; every following line is a `TranscriptRecord` for
 * one event, in emission order. The log is the durable copy of the conversation:
 * a live session writes it, and replay reads it back without calling a model.
 *
 * The log carries its own schema version. A reader accepts an older minor
 * version (additive changes stay readable) and rejects any other major version
 * instead of guessing. A log cut off mid-line replays to its last complete
 * record and reports the truncation; it never fabricates a completion.
 */

export class SessionLogFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionLogFormatError'
  }
}

export class SessionLogVersionError extends SessionLogFormatError {
  readonly version: string
  readonly currentVersion: string

  constructor(version: string, currentVersion: string) {
    super(
      `session log schema ${version} is not readable by this build (current ${currentVersion}); migrate it first`,
    )
    this.name = 'SessionLogVersionError'
    this.version = version
    this.currentVersion = currentVersion
  }
}

export const sessionLogHeaderSchema = z.strictObject({
  type: z.literal('session.header'),
  schemaVersion: transcriptSchemaVersionSchema,
  sessionId: z.string().min(1),
  /** Wall-clock ISO timestamp of session start; the only wall time in the log. */
  startedAt: z.iso.datetime({ offset: true }),
  clockMode: clockModeSchema,
  lang: sessionLanguageSchema,
  /** Model adapter label. Never contains a secret. */
  provider: z.string().min(1),
  /** Present only when the session replays a registered task. */
  taskId: z.string().min(1).optional(),
  /** M2 session identity. Optional so an M1 log still parses. */
  personaId: z.string().min(1).optional(),
  personaVersion: z.string().min(1).optional(),
  scenarioId: z.string().min(1).optional(),
  scenarioVersion: z.string().min(1).optional(),
  /** Canonical BCP 47 tag. `lang` stays the base language. */
  locale: z.string().min(1).optional(),
  promptVersion: z.string().min(1).optional(),
})

export type SessionLogHeader = z.infer<typeof sessionLogHeaderSchema>

/** One log line: the header first, then transcript records. */
export type SessionLogLine = SessionLogHeader | TranscriptRecord

export interface BuildSessionLogRecordOptions {
  readonly header: SessionLogHeader
  readonly event: SessionEvent
  readonly seq: number
  readonly tSim: number
  readonly tWall: number
}

/**
 * Build the record a live session appends for one event. `runId` is the session
 * id: the log is one process's conversation, not a suite run.
 */
export function buildSessionLogRecord(options: BuildSessionLogRecordOptions): TranscriptRecord {
  const { header, event, seq, tSim, tWall } = options
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    runId: header.sessionId,
    seq,
    tSim,
    tWall,
    kind: event.type,
    payload: event.payload,
    contentClass: expectedContentClass(event.type),
  }
}

/** Canonical JSON line for the header. Append `\n` when writing. */
export function sessionLogHeaderLine(header: SessionLogHeader): string {
  return canonicalJson(header)
}

/** Canonical JSON line for one transcript record. Append `\n` when writing. */
export function sessionLogRecordLine(record: TranscriptRecord): string {
  return canonicalJson(record)
}

export interface ParsedSessionLog {
  readonly header: SessionLogHeader
  readonly records: readonly TranscriptRecord[]
  /** True when the final line was incomplete and had to be dropped. */
  readonly truncated: boolean
  /**
   * True when the log does not end with `session.completed`. A process killed
   * after a complete append leaves a parseable final line but an unfinished
   * turn; replay reports this instead of printing the log as a normal session.
   */
  readonly unterminated: boolean
}

export interface ReplayedSession extends ParsedSessionLog {
  readonly events: readonly SessionEvent[]
  /** Canonical normalized transcript, identical to the one G1 compares. */
  readonly jsonl: string
}

/**
 * Parse a log. Throws on a missing/invalid header, a malformed interior line,
 * a non-event record, an unreadable major version, a record from another run,
 * or a `seq` gap. An incomplete final line is dropped and reported as
 * `truncated`; a log without `session.completed` is reported as `unterminated`.
 */
export function parseSessionLog(text: string): ParsedSessionLog {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) throw new SessionLogFormatError('session log is empty')

  const headerLine = lines[0] as string
  let headerValue: unknown
  try {
    headerValue = JSON.parse(headerLine)
  } catch {
    throw new SessionLogFormatError('session log does not start with a valid header')
  }

  const headerResult = sessionLogHeaderSchema.safeParse(headerValue)
  if (!headerResult.success) {
    throw new SessionLogFormatError(
      `session log header is invalid: ${headerResult.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    )
  }
  const header = headerResult.data

  if (
    majorOfSchemaVersion(header.schemaVersion) !== majorOfSchemaVersion(TRANSCRIPT_SCHEMA_VERSION)
  ) {
    throw new SessionLogVersionError(header.schemaVersion, TRANSCRIPT_SCHEMA_VERSION)
  }

  const records: TranscriptRecord[] = []
  let truncated = false

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (line.trim() === '') {
      throw new SessionLogFormatError(`session log line ${index + 1} is blank`)
    }

    const isLast = index === lines.length - 1
    let parsedLine: unknown
    try {
      parsedLine = JSON.parse(line)
    } catch {
      if (isLast) {
        truncated = true
        break
      }
      throw new SessionLogFormatError(`session log line ${index + 1} is not valid JSON`)
    }

    records.push(parseRecord(parsedLine, index + 1))
  }

  // The writer stamps `runId = sessionId` and a contiguous `seq` starting at 0.
  // Re-checking both on read is free here and makes a lost interior record or a
  // concatenated log fail instead of replaying as a clean session.
  for (const [position, record] of records.entries()) {
    if (record.runId !== header.sessionId) {
      throw new SessionLogFormatError(
        `session log record ${position} belongs to run "${record.runId}", not "${header.sessionId}"`,
      )
    }
    if (record.seq !== position) {
      throw new SessionLogFormatError(
        `session log record ${position} has seq ${record.seq}; a session log must be contiguous from 0`,
      )
    }
  }

  const lastRecord = records.at(-1)
  const unterminated = lastRecord === undefined || lastRecord.kind !== 'session.completed'

  return { header, records, truncated, unterminated }
}

function parseRecord(line: unknown, lineNumber: number): TranscriptRecord {
  try {
    return parseTranscriptRecord(line)
  } catch (error) {
    if (error instanceof TranscriptSchemaVersionError) {
      throw new SessionLogVersionError(error.version, error.expectedVersion)
    }
    throw new SessionLogFormatError(
      `session log line ${lineNumber} is not a valid transcript record: ${messageOf(error)}`,
    )
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read a log back without a model. The recorded events are returned as-is and
 * the normalized transcript is rebuilt from the stored records, so a replay can
 * never depend on a provider being available.
 */
export function replaySessionLog(text: string): ReplayedSession {
  const parsed = parseSessionLog(text)
  const events: SessionEvent[] = []

  for (const record of parsed.records) {
    const event = eventFromTranscriptRecord(record)
    if (event === undefined) {
      throw new SessionLogFormatError(
        `record ${record.seq} has non-event kind "${record.kind}"; a session log only stores events`,
      )
    }
    events.push(event)
  }

  return {
    ...parsed,
    events,
    jsonl: normalizedTranscriptJsonl(parsed.records),
  }
}

/** Normalized form of the stored records, for comparing a replay with the live run. */
export function normalizedSessionLog(records: readonly TranscriptRecord[]): string {
  return normalizedTranscriptJsonl(records)
}
