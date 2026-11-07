import { canonicalJson } from '@rp/shared'
import { describe, expect, it } from 'vitest'
import {
  eventFromTranscriptRecord,
  NORMALIZED_EXECUTION_ID,
  NORMALIZED_T_WALL,
  normalizeTranscriptRecord,
  normalizedTranscriptJsonl,
  parseTranscriptRecord,
  transcriptRecordSchema,
  type TranscriptRecord,
} from './transcript.js'
import { GuardViolationError } from './guards.js'
import { TRANSCRIPT_SCHEMA_VERSION } from './version.js'

const RUN_ID = 'run-2026-01-01T00-00-00Z'
const EXECUTION_ID = 'run-2026-01-01T00-00-00Z-20260101T000000Z-deadbeef'
const WALL_CLOCK = 1_735_689_600_123
const EXPIRES_AT = '2026-01-01T00:00:00.000Z'

function record(seq: number): TranscriptRecord {
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    runId: RUN_ID,
    executionId: EXECUTION_ID,
    seq,
    tSim: seq * 100,
    tWall: WALL_CLOCK + seq,
    kind: 'user.started_speaking',
    payload: {},
    contentClass: 'contentFree',
  }
}

function grantRecord(seq: number): TranscriptRecord {
  return {
    ...record(seq),
    kind: 'turn.granted',
    payload: {
      grant: {
        turnId: 'turn-1',
        grantId: 'grant-1',
        personaId: 'persona-1',
        expiresAt: EXPIRES_AT,
      },
    },
    contentClass: 'contentFree',
  }
}

describe('transcriptRecordSchema', () => {
  it('accepts a valid event record', () => {
    expect(transcriptRecordSchema.safeParse(grantRecord(0)).success).toBe(true)
  })

  it('requires a content class', () => {
    const missingContentClass = {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      runId: RUN_ID,
      seq: 0,
      tSim: 0,
      tWall: WALL_CLOCK,
      kind: 'user.started_speaking',
      payload: {},
    }
    expect(transcriptRecordSchema.safeParse(missingContentClass).success).toBe(false)
  })

  it('rejects an unknown content class', () => {
    expect(transcriptRecordSchema.safeParse({ ...record(0), contentClass: 'secret' }).success).toBe(
      false,
    )
  })

  it('rejects a non-semver schema version', () => {
    expect(transcriptRecordSchema.safeParse({ ...record(0), schemaVersion: 'v1' }).success).toBe(
      false,
    )
  })

  it('validates an event payload through its event schema', () => {
    expect(
      transcriptRecordSchema.safeParse({
        ...record(0),
        kind: 'turn.granted',
        payload: { grant: { turnId: 'turn-1' } },
      }).success,
    ).toBe(false)
  })

  it('accepts a non-event kind with an opaque payload', () => {
    expect(
      transcriptRecordSchema.safeParse({
        ...record(0),
        kind: 'engine.latency_ms',
        payload: { operation: 'append', value: 1.5 },
      }).success,
    ).toBe(true)
  })

  it('rejects a text-bearing event emitted as public', () => {
    const chunk = {
      ...record(0),
      kind: 'persona.response.chunk',
      payload: { grantId: 'grant-1', text: 'Hi', sequence: 0 },
      contentClass: 'public',
    }

    expect(transcriptRecordSchema.safeParse(chunk).success).toBe(false)
    expect(transcriptRecordSchema.safeParse({ ...chunk, contentClass: 'restricted' }).success).toBe(
      true,
    )
  })

  it('rejects an operational event classified as public or restricted', () => {
    expect(transcriptRecordSchema.safeParse({ ...record(0), contentClass: 'public' }).success).toBe(
      false,
    )
    expect(
      transcriptRecordSchema.safeParse({ ...record(0), contentClass: 'restricted' }).success,
    ).toBe(false)
  })

  it('leaves a non-event record free to choose its content class', () => {
    expect(
      transcriptRecordSchema.safeParse({
        ...record(0),
        kind: 'engine.latency_ms',
        payload: { value: 1 },
        contentClass: 'public',
      }).success,
    ).toBe(true)
  })

  it('accepts a record without an execution id for backward compatibility', () => {
    const { executionId: _executionId, ...legacy } = record(0)
    expect(transcriptRecordSchema.safeParse(legacy).success).toBe(true)
  })

  it('rejects a negative or fractional seq', () => {
    expect(transcriptRecordSchema.safeParse({ ...record(0), seq: -1 }).success).toBe(false)
    expect(transcriptRecordSchema.safeParse({ ...record(0), seq: 0.5 }).success).toBe(false)
  })
})

describe('parseTranscriptRecord', () => {
  it('returns the validated record', () => {
    const parsed = parseTranscriptRecord(grantRecord(3))
    expect(parsed.kind).toBe('turn.granted')
    expect(parsed.seq).toBe(3)
  })

  it('throws on an invalid record', () => {
    expect(() => parseTranscriptRecord({ ...record(0), contentClass: 'nope' })).toThrow()
  })
})

describe('eventFromTranscriptRecord', () => {
  it('recovers a typed event and validates the payload', () => {
    const event = eventFromTranscriptRecord(grantRecord(0))
    expect(event?.type).toBe('turn.granted')
    if (event?.type === 'turn.granted') {
      expect(event.payload.grant.grantId).toBe('grant-1')
    }
  })

  it('returns undefined for non-event kinds', () => {
    const operational = { ...record(0), kind: 'engine.latency_ms', payload: { value: 1 } }
    expect(eventFromTranscriptRecord(operational)).toBeUndefined()
  })

  it('throws when an event payload is invalid', () => {
    const broken = { ...record(0), kind: 'turn.granted', payload: {} }
    expect(() => eventFromTranscriptRecord(broken)).toThrow()
  })
})

describe('normalizeTranscriptRecord', () => {
  it('pins tWall and executionId and keeps simulated time', () => {
    const normalized = normalizeTranscriptRecord(record(2))
    expect(normalized.tWall).toBe(NORMALIZED_T_WALL)
    expect(normalized.executionId).toBe(NORMALIZED_EXECUTION_ID)
    expect(normalized.tSim).toBe(200)
  })

  it('makes two executions of the same suite compare equal', () => {
    const first = record(0)
    const second = { ...record(0), executionId: 'another-execution', tWall: 9_999_999 }

    expect(normalizeTranscriptRecord(first)).toEqual(normalizeTranscriptRecord(second))
  })
})

describe('normalizedTranscriptJsonl', () => {
  it('is stable across key insertion order and differing wall-clock time and execution', () => {
    const first: TranscriptRecord = {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      runId: RUN_ID,
      executionId: 'execution-one',
      seq: 0,
      tSim: 0,
      tWall: 1_000,
      kind: 'user.started_speaking',
      payload: {},
      contentClass: 'contentFree',
    }

    const second: TranscriptRecord = {
      contentClass: 'contentFree',
      payload: {},
      kind: 'user.started_speaking',
      tWall: 9_999_999,
      executionId: 'execution-two',
      tSim: 0,
      seq: 0,
      runId: RUN_ID,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    }

    expect(normalizedTranscriptJsonl([first])).toBe(normalizedTranscriptJsonl([second]))
  })

  it('contains no wall-clock value or execution identity in the output', () => {
    const jsonl = normalizedTranscriptJsonl([record(0)])
    expect(jsonl).not.toContain(String(WALL_CLOCK))
    expect(jsonl).not.toContain(EXECUTION_ID)

    const parsed = JSON.parse(jsonl) as { tWall: number; executionId: string }
    expect(parsed.tWall).toBe(NORMALIZED_T_WALL)
    expect(parsed.executionId).toBe(NORMALIZED_EXECUTION_ID)
  })

  it('emits one canonical JSON record per line with sorted keys', () => {
    const records = [record(0), grantRecord(1)]
    const jsonl = normalizedTranscriptJsonl(records)
    const lines = jsonl.trimEnd().split('\n')

    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(canonicalJson(normalizeTranscriptRecord(records[0] as TranscriptRecord)))
    expect(lines[1]).toBe(canonicalJson(normalizeTranscriptRecord(records[1] as TranscriptRecord)))
    expect(lines[0]?.startsWith('{"contentClass":')).toBe(true)
    expect(jsonl.endsWith('\n')).toBe(true)
  })

  it('returns an empty string for an empty run', () => {
    expect(normalizedTranscriptJsonl([])).toBe('')
  })

  it('rejects duplicated transcript seq', () => {
    expect(() => normalizedTranscriptJsonl([record(0), record(0)])).toThrow(GuardViolationError)
  })

  it('rejects reordered transcript seq', () => {
    expect(() => normalizedTranscriptJsonl([record(2), record(1)])).toThrow(/strictly increase/)
  })

  it('rejects an invalid record before serializing', () => {
    expect(() => normalizedTranscriptJsonl([{ ...record(0), contentClass: 'secret' }])).toThrow()
  })

  it('rejects an invalid event payload before serializing', () => {
    expect(() =>
      normalizedTranscriptJsonl([{ ...record(0), kind: 'persona.response.chunk', payload: {} }]),
    ).toThrow()
  })
})
