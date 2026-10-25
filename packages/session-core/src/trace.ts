import { canonicalJson } from '@rp/shared'
import { z } from 'zod'
import {
  eventPayloadSchemas,
  isSessionEventName,
  type SessionEvent,
  type SessionEventName,
  type SessionEventPayload,
} from './events.js'
import { checkTraceSequence, enforceGuardResult } from './guards.js'
import { traceSchemaVersionSchema } from './version.js'

/**
 * Append-only trace records (M0 D2).
 *
 * `contentClass` is required by construction so §9 trace privacy cannot be
 * forgotten: operational metrics are `contentFree`, loggable summaries are
 * `public`, and anything carrying user text, hidden objectives, or exact model
 * payloads is `restricted` (encrypt/restrict, never ordinary logs).
 */

export const contentClassSchema = z.enum(['public', 'restricted', 'contentFree'])

export type ContentClass = z.infer<typeof contentClassSchema>

/**
 * Trace record envelope. When `kind` is one of the §2.1 event names, `payload`
 * must parse against that event's payload schema (see the refinement below).
 * Non-event kinds (for example latency samples) stay `unknown` payloads but
 * still need a content class.
 */
const traceRecordBaseSchema = z.strictObject({
  schemaVersion: traceSchemaVersionSchema,
  runId: z.string().min(1),
  /** Strictly increasing across the run; see `checkTraceSequence`. */
  seq: z.int().nonnegative(),
  /** Simulated clock time in milliseconds. Deterministic; kept in normalized output. */
  tSim: z.number().nonnegative(),
  /** Wall-clock time in milliseconds since the epoch. Removed by normalization. */
  tWall: z.number().nonnegative(),
  kind: z.string().min(1),
  payload: z.unknown(),
  contentClass: contentClassSchema,
})

/**
 * Validates the envelope and, for event kinds, the payload through the same
 * schema the engine uses. This is what lets the eval runner trust a trace file
 * without importing engine code.
 */
export const traceRecordSchema = traceRecordBaseSchema.superRefine((record, ctx) => {
  if (!isSessionEventName(record.kind)) return

  const payloadSchema = eventPayloadSchemas[record.kind] as z.ZodType
  const result = payloadSchema.safeParse(record.payload)
  if (result.success) return

  for (const issue of result.error.issues) {
    ctx.addIssue({
      code: 'custom',
      message: issue.message,
      path: ['payload', ...issue.path],
    })
  }
})

export type TraceRecord = z.infer<typeof traceRecordSchema>

/** A trace record whose kind is a §2.1 event and whose payload passed validation. */
export type EventTraceRecord = TraceRecord & {
  readonly kind: SessionEventName
  readonly payload: SessionEventPayload
}

/** Parse an untrusted trace record, including its event payload. */
export function parseTraceRecord(input: unknown): TraceRecord {
  return traceRecordSchema.parse(input)
}

/**
 * Recover the event from a trace record. Returns `undefined` for non-event
 * kinds (operational records). Throws if an event payload is invalid; use
 * `parseTraceRecord` first when input is untrusted.
 */
export function eventFromTraceRecord(record: TraceRecord): SessionEvent | undefined {
  if (!isSessionEventName(record.kind)) return undefined

  const payload = (eventPayloadSchemas[record.kind] as z.ZodType).parse(record.payload)
  return { type: record.kind, payload } as SessionEvent
}

/**
 * Value written to `tWall` by normalization.
 *
 * Wall-clock time is the only non-reproducible field in a trace (§2.3), so it is
 * pinned to a constant instead of removed: the schema and every reader stay the
 * same shape, while the normalized bytes contain no wall-clock value.
 */
export const NORMALIZED_T_WALL = 0

/** Copy one record with wall-clock time removed (`tWall` = 0). */
export function normalizeTraceRecord(record: TraceRecord): TraceRecord {
  return { ...record, tWall: NORMALIZED_T_WALL }
}

/** Copy records with wall-clock time removed. Does not validate. */
export function normalizeTraceRecords(records: readonly TraceRecord[]): TraceRecord[] {
  return records.map((record) => normalizeTraceRecord(record))
}

/**
 * Canonical JSONL for replay comparison (G1): one validated record per line,
 * keys sorted by `canonicalJson`, `tWall` normalized, and a trailing newline.
 *
 * Rejects (throws) non-monotonic `seq` with a `GuardViolationError` and invalid
 * records with a `ZodError`. Identical simulated runs therefore serialize to
 * byte-identical strings; two runs that differ only in wall-clock time do too.
 */
export function normalizedTraceJsonl(records: readonly unknown[]): string {
  const parsed = records.map((record) => parseTraceRecord(record))
  const sequence = checkTraceSequence(parsed)
  enforceGuardResult(sequence, { strict: true })

  if (parsed.length === 0) return ''

  const lines = parsed.map((record) => canonicalJson(normalizeTraceRecord(record)))
  return `${lines.join('\n')}\n`
}
