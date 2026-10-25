import { canonicalJson } from '@rp/shared'
import { describe, expect, it } from 'vitest'
import {
  eventFromTraceRecord,
  NORMALIZED_T_WALL,
  normalizeTraceRecord,
  normalizedTraceJsonl,
  parseTraceRecord,
  traceRecordSchema,
  type TraceRecord,
} from './trace.js'
import { GuardViolationError } from './guards.js'
import { TRACE_SCHEMA_VERSION } from './version.js'

const RUN_ID = 'run-2026-01-01T00-00-00Z'
const WALL_CLOCK = 1_735_689_600_123
const EXPIRES_AT = '2026-01-01T00:00:00.000Z'

function record(seq: number): TraceRecord {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    runId: RUN_ID,
    seq,
    tSim: seq * 100,
    tWall: WALL_CLOCK + seq,
    kind: 'user.started_speaking',
    payload: {},
    contentClass: 'contentFree',
  }
}

function grantRecord(seq: number): TraceRecord {
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
    contentClass: 'public',
  }
}

describe('traceRecordSchema', () => {
  it('accepts a valid event record', () => {
    expect(traceRecordSchema.safeParse(grantRecord(0)).success).toBe(true)
  })

  it('requires a content class', () => {
    const missingContentClass = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      runId: RUN_ID,
      seq: 0,
      tSim: 0,
      tWall: WALL_CLOCK,
      kind: 'user.started_speaking',
      payload: {},
    }
    expect(traceRecordSchema.safeParse(missingContentClass).success).toBe(false)
  })

  it('rejects an unknown content class', () => {
    expect(traceRecordSchema.safeParse({ ...record(0), contentClass: 'secret' }).success).toBe(
      false,
    )
  })

  it('rejects a non-semver schema version', () => {
    expect(traceRecordSchema.safeParse({ ...record(0), schemaVersion: 'v1' }).success).toBe(false)
  })

  it('validates an event payload through its event schema', () => {
    expect(
      traceRecordSchema.safeParse({
        ...record(0),
        kind: 'turn.granted',
        payload: { grant: { turnId: 'turn-1' } },
      }).success,
    ).toBe(false)
  })

  it('accepts a non-event kind with an opaque payload', () => {
    expect(
      traceRecordSchema.safeParse({
        ...record(0),
        kind: 'engine.latency_ms',
        payload: { operation: 'append', value: 1.5 },
      }).success,
    ).toBe(true)
  })

  it('rejects a negative or fractional seq', () => {
    expect(traceRecordSchema.safeParse({ ...record(0), seq: -1 }).success).toBe(false)
    expect(traceRecordSchema.safeParse({ ...record(0), seq: 0.5 }).success).toBe(false)
  })
})

describe('parseTraceRecord', () => {
  it('returns the validated record', () => {
    const parsed = parseTraceRecord(grantRecord(3))
    expect(parsed.kind).toBe('turn.granted')
    expect(parsed.seq).toBe(3)
  })

  it('throws on an invalid record', () => {
    expect(() => parseTraceRecord({ ...record(0), contentClass: 'nope' })).toThrow()
  })
})

describe('eventFromTraceRecord', () => {
  it('recovers a typed event and validates the payload', () => {
    const event = eventFromTraceRecord(grantRecord(0))
    expect(event?.type).toBe('turn.granted')
    if (event?.type === 'turn.granted') {
      expect(event.payload.grant.grantId).toBe('grant-1')
    }
  })

  it('returns undefined for non-event kinds', () => {
    const operational = { ...record(0), kind: 'engine.latency_ms', payload: { value: 1 } }
    expect(eventFromTraceRecord(operational)).toBeUndefined()
  })

  it('throws when an event payload is invalid', () => {
    const broken = { ...record(0), kind: 'turn.granted', payload: {} }
    expect(() => eventFromTraceRecord(broken)).toThrow()
  })
})

describe('normalizeTraceRecord', () => {
  it('pins tWall to the normalized constant and keeps simulated time', () => {
    const normalized = normalizeTraceRecord(record(2))
    expect(normalized.tWall).toBe(NORMALIZED_T_WALL)
    expect(normalized.tSim).toBe(200)
  })
})

describe('normalizedTraceJsonl', () => {
  it('is stable across key insertion order and differing wall-clock time', () => {
    const first: TraceRecord = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      runId: RUN_ID,
      seq: 0,
      tSim: 0,
      tWall: 1_000,
      kind: 'user.started_speaking',
      payload: {},
      contentClass: 'public',
    }

    const second: TraceRecord = {
      contentClass: 'public',
      payload: {},
      kind: 'user.started_speaking',
      tWall: 9_999_999,
      tSim: 0,
      seq: 0,
      runId: RUN_ID,
      schemaVersion: TRACE_SCHEMA_VERSION,
    }

    expect(normalizedTraceJsonl([first])).toBe(normalizedTraceJsonl([second]))
  })

  it('contains no wall-clock value in the output', () => {
    const jsonl = normalizedTraceJsonl([record(0)])
    expect(jsonl).not.toContain(String(WALL_CLOCK))

    const parsed = JSON.parse(jsonl) as { tWall: number }
    expect(parsed.tWall).toBe(NORMALIZED_T_WALL)
  })

  it('emits one canonical JSON record per line with sorted keys', () => {
    const records = [record(0), grantRecord(1)]
    const jsonl = normalizedTraceJsonl(records)
    const lines = jsonl.trimEnd().split('\n')

    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(canonicalJson(normalizeTraceRecord(records[0] as TraceRecord)))
    expect(lines[1]).toBe(canonicalJson(normalizeTraceRecord(records[1] as TraceRecord)))
    expect(lines[0]?.startsWith('{"contentClass":')).toBe(true)
    expect(jsonl.endsWith('\n')).toBe(true)
  })

  it('returns an empty string for an empty run', () => {
    expect(normalizedTraceJsonl([])).toBe('')
  })

  it('rejects duplicated trace seq', () => {
    expect(() => normalizedTraceJsonl([record(0), record(0)])).toThrow(GuardViolationError)
  })

  it('rejects reordered trace seq', () => {
    expect(() => normalizedTraceJsonl([record(2), record(1)])).toThrow(/strictly increase/)
  })

  it('rejects an invalid record before serializing', () => {
    expect(() => normalizedTraceJsonl([{ ...record(0), contentClass: 'secret' }])).toThrow()
  })

  it('rejects an invalid event payload before serializing', () => {
    expect(() =>
      normalizedTraceJsonl([{ ...record(0), kind: 'persona.response.chunk', payload: {} }]),
    ).toThrow()
  })
})
