import { describe, expect, it } from 'vitest'
import type { SessionEvent } from './events.js'
import {
  buildSessionLogRecord,
  parseSessionLog,
  replaySessionLog,
  sessionLogHeaderLine,
  sessionLogRecordLine,
  SessionLogFormatError,
  SessionLogVersionError,
  type SessionLogHeader,
} from './session-log.js'
import { normalizedTranscriptJsonl, type TranscriptRecord } from './transcript.js'
import { TRANSCRIPT_SCHEMA_VERSION } from './version.js'

const header: SessionLogHeader = {
  type: 'session.header',
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  sessionId: 'session-1',
  startedAt: '2026-11-07T10:00:00.000Z',
  clockMode: 'simulated',
  lang: 'en',
  provider: 'canned',
  taskId: 'task-1',
}

const events: readonly SessionEvent[] = [
  {
    type: 'session.started',
    payload: { sessionId: 'session-1', clockMode: 'simulated', lang: 'en', taskId: 'task-1' },
  },
  { type: 'user.utterance.committed', payload: { text: 'hello' } },
  { type: 'persona.response.committed', payload: { grantId: 'grant-1', text: 'Hello there' } },
  { type: 'session.completed', payload: {} },
]

function recordsFor(
  source: readonly SessionEvent[] = events,
  logHeader: SessionLogHeader = header,
): TranscriptRecord[] {
  return source.map((event, index) =>
    buildSessionLogRecord({
      header: logHeader,
      event,
      seq: index,
      tSim: index * 100,
      tWall: 1_700_000_000_000 + index,
    }),
  )
}

function textFor(
  records: readonly TranscriptRecord[],
  logHeader: SessionLogHeader = header,
): string {
  return `${[sessionLogHeaderLine(logHeader), ...records.map(sessionLogRecordLine)].join('\n')}\n`
}

describe('session log', () => {
  it('round-trips the header and every record', () => {
    const records = recordsFor()
    const parsed = parseSessionLog(textFor(records))

    expect(parsed.header).toEqual(header)
    expect(parsed.records).toEqual(records)
    expect(parsed.truncated).toBe(false)
  })

  it('replays the recorded events without a model and rebuilds the normalized transcript', () => {
    const records = recordsFor()
    const replayed = replaySessionLog(textFor(records))

    expect(replayed.events).toEqual(events)
    expect(replayed.jsonl).toBe(normalizedTranscriptJsonl(records))
    expect(replayed.truncated).toBe(false)
  })

  it('keeps runId equal to the session id and marks text records restricted', () => {
    const records = recordsFor()

    expect(records.every((record) => record.runId === 'session-1')).toBe(true)
    expect(records[1]?.contentClass).toBe('restricted')
    expect(records[0]?.contentClass).toBe('contentFree')
  })

  it('drops an incomplete final line, reports truncation, and fabricates nothing', () => {
    const records = recordsFor()
    const complete = textFor(records)
    const truncatedText = complete.slice(0, complete.length - 12)

    const replayed = replaySessionLog(truncatedText)

    expect(replayed.truncated).toBe(true)
    expect(replayed.records).toHaveLength(records.length - 1)
    expect(replayed.events.some((event) => event.type === 'session.completed')).toBe(false)
    expect(replayed.jsonl).toBe(normalizedTranscriptJsonl(records.slice(0, -1)))
  })

  it('rejects a different major schema version instead of guessing', () => {
    const records = recordsFor()
    const outdated = { ...header, schemaVersion: '2.0.0' }

    expect(() => parseSessionLog(textFor(records, outdated))).toThrow(SessionLogVersionError)
  })

  it('rejects a record whose major version differs from the header', () => {
    const records = recordsFor().map((record, index) =>
      index === 1 ? { ...record, schemaVersion: '2.0.0' } : record,
    )

    expect(() => parseSessionLog(textFor(records))).toThrow(SessionLogVersionError)
  })

  it('reports an incompatible version even when the record payload has a v2 shape', () => {
    const records = recordsFor().map((record, index) =>
      index === 1
        ? {
            ...record,
            schemaVersion: '2.0.0',
            kind: 'persona.response.chunk',
            payload: { grantId: 'grant-1', text: 'hi' }, // v2 dropped `sequence`
            contentClass: 'restricted' as const,
          }
        : record,
    )

    expect(() => parseSessionLog(textFor(records))).toThrow(SessionLogVersionError)
  })

  it('rejects a record that belongs to another run', () => {
    const records = recordsFor().map((record, index) =>
      index === 1 ? { ...record, runId: 'another-session' } : record,
    )

    expect(() => parseSessionLog(textFor(records))).toThrow(/belongs to run "another-session"/)
  })

  it('rejects a seq gap instead of accepting a lost interior record', () => {
    const records = recordsFor().filter((_record, index) => index !== 2)

    expect(() => parseSessionLog(textFor(records))).toThrow(/seq 3; .*contiguous/)
  })

  it('marks a log that does not end with session.completed as unterminated', () => {
    const records = recordsFor(events.slice(0, -1))
    const parsed = parseSessionLog(textFor(records))

    expect(parsed.unterminated).toBe(true)
    expect(parseSessionLog(textFor(recordsFor())).unterminated).toBe(false)
  })

  it('accepts an older minor version, because additive changes stay readable', () => {
    const records = recordsFor()
    const older = { ...header, schemaVersion: '1.0.0' }

    expect(parseSessionLog(textFor(records, older)).records).toHaveLength(records.length)
  })

  it('replays 1.0.0 records classified under the old, looser rule', () => {
    const legacyHeader: SessionLogHeader = { ...header, schemaVersion: '1.0.0' }
    const legacyRecords = recordsFor().map((record) => ({
      ...record,
      schemaVersion: '1.0.0',
      contentClass: 'public' as const,
    }))
    const text = textFor(legacyRecords, legacyHeader)

    expect(parseSessionLog(text).records).toHaveLength(legacyRecords.length)
    expect(replaySessionLog(text).events).toEqual(events)
  })

  it('rejects a log that does not start with a header', () => {
    const records = recordsFor()
    const text = `${records.map(sessionLogRecordLine).join('\n')}\n`

    expect(() => parseSessionLog(text)).toThrow(SessionLogFormatError)
  })

  it('rejects a blank interior line', () => {
    const records = recordsFor()
    const lines = [sessionLogHeaderLine(header), ...records.map(sessionLogRecordLine)]
    const text = `${lines[0]}\n\n${lines.slice(1).join('\n')}\n`

    expect(() => parseSessionLog(text)).toThrow(/blank/)
  })

  it('treats a whitespace-only interior line as blank', () => {
    const records = recordsFor()
    const lines = [sessionLogHeaderLine(header), ...records.map(sessionLogRecordLine)]
    const text = `${lines[0]}\n   \n${lines.slice(1).join('\n')}\n`

    expect(() => parseSessionLog(text)).toThrow(/line 2 is blank/)
  })

  it('names the line number of a malformed interior line', () => {
    const records = recordsFor()
    const lines = [sessionLogHeaderLine(header), ...records.map(sessionLogRecordLine)]
    lines[2] = '{"broken"'

    expect(() => parseSessionLog(`${lines.join('\n')}\n`)).toThrow(/line 3 is not valid JSON/)
  })

  it('names the header field that is invalid', () => {
    const records = recordsFor()
    const invalidHeader: SessionLogHeader = { ...header, taskId: '' }

    expect(() => parseSessionLog(textFor(records, invalidHeader))).toThrow(/taskId:/)
  })

  it('wraps a non-version record error as a format error', () => {
    const records = recordsFor().map((record, index) =>
      index === 2 ? { ...record, contentClass: 'public' as const } : record,
    )

    try {
      parseSessionLog(textFor(records))
      throw new Error('expected the log to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(SessionLogFormatError)
      expect(error).not.toBeInstanceOf(SessionLogVersionError)
      expect((error as Error).message).toMatch(/not a valid transcript record/)
    }
  })

  it('rejects an empty log', () => {
    expect(() => parseSessionLog('')).toThrow(/empty/)
  })

  it('rejects a malformed interior line instead of truncating the middle', () => {
    const records = recordsFor()
    const lines = [sessionLogHeaderLine(header), ...records.map(sessionLogRecordLine)]
    lines[2] = '{"broken"'

    expect(() => parseSessionLog(`${lines.join('\n')}\n`)).toThrow(/not valid JSON/)
  })

  it('rejects a content-class privacy violation stored in the log', () => {
    const records = recordsFor().map((record, index) =>
      index === 2 ? { ...record, contentClass: 'public' as const } : record,
    )

    expect(() => parseSessionLog(textFor(records))).toThrow()
  })

  it('rejects a non-event record during replay', () => {
    const operational: TranscriptRecord = {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      runId: 'session-1',
      seq: 4,
      tSim: 400,
      tWall: 1_700_000_000_400,
      kind: 'engine.latency_ms',
      payload: { value: 1 },
      contentClass: 'contentFree',
    }
    const records = [...recordsFor(), operational]

    expect(() => replaySessionLog(textFor(records))).toThrow(/non-event kind/)
  })
})
