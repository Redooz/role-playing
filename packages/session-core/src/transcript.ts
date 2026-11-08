import { canonicalJson } from '@rp/shared'
import { z } from 'zod'
import {
  eventPayloadSchemas,
  isSessionEventName,
  type SessionEvent,
  type SessionEventName,
  type SessionEventPayload,
} from './events.js'
import { checkTranscriptSequence, enforceGuardResult } from './guards.js'
import {
  CONTENT_CLASS_RULE_SINCE,
  isTranscriptSchemaAtLeast,
  majorOfSchemaVersion,
  TRANSCRIPT_SCHEMA_VERSION,
  transcriptSchemaVersionSchema,
} from './version.js'

/** A transcript record whose major version this build cannot read. */
export class TranscriptSchemaVersionError extends Error {
  readonly version: string
  readonly expectedVersion: string

  constructor(version: string, expectedVersion: string) {
    super(
      `transcript schema ${version} is not readable by this build (current ${expectedVersion}); migrate it first`,
    )
    this.name = 'TranscriptSchemaVersionError'
    this.version = version
    this.expectedVersion = expectedVersion
  }
}

/**
 * Append-only transcript records (M0 D2).
 *
 * `contentClass` is required by construction so §9 transcript privacy cannot be
 * forgotten: operational metrics are `contentFree`, loggable summaries are
 * `public`, and anything carrying user text, hidden objectives, or exact model
 * payloads is `restricted` (encrypt/restrict, never ordinary logs).
 */

export const contentClassSchema = z.enum(['public', 'restricted', 'contentFree'])

export type ContentClass = z.infer<typeof contentClassSchema>

/**
 * Event kinds whose payload carries user or persona text. These may only be
 * `restricted`: exporting them as `public` (or `contentFree`) would let transcript
 * privacy depend on a producer remembering the rule.
 */
const RESTRICTED_EVENT_KINDS: ReadonlySet<SessionEventName> = new Set([
  'user.utterance.committed',
  'persona.utterance.partial',
  'persona.response.chunk',
  'persona.response.committed',
  'persona.response.cancelled',
])

/**
 * Non-event record kinds whose payload is verified safe to log verbatim. The
 * set is empty until a producer can prove that: everything else must be
 * `restricted` or `contentFree`, so a custom record cannot claim `public` and
 * bypass the privacy rule.
 */
const PUBLIC_NON_EVENT_KINDS: ReadonlySet<string> = new Set()

/**
 * The content class an event kind must carry. Text-bearing kinds are
 * `restricted`; operational kinds are `contentFree`. `public` is reserved for a
 * non-event kind on the explicit allowlist, which is empty today.
 */
export function expectedContentClass(kind: SessionEventName): ContentClass {
  return RESTRICTED_EVENT_KINDS.has(kind) ? 'restricted' : 'contentFree'
}

/**
 * Transcript record envelope. When `kind` is one of the §2.1 event names, `payload`
 * must parse against that event's payload schema (see the refinement below).
 * Non-event kinds (for example latency samples) stay `unknown` payloads but
 * still need a content class.
 */
const transcriptRecordBaseSchema = z.strictObject({
  schemaVersion: transcriptSchemaVersionSchema,
  runId: z.string().min(1),
  /**
   * Identifies one execution of the suite; `runId` only names the suite and is
   * reused by every execution. Optional so records written before 1.1.0 still
   * parse. Eval transcripts set it; a session log uses `runId` for the session
   * id and may omit it.
   */
  executionId: z.string().min(1).optional(),
  /** Strictly increasing across the run; see `checkTranscriptSequence`. */
  seq: z.int().nonnegative(),
  /**
   * Simulated clock time in milliseconds. A wall-mode session log pins it to 0
   * (see `createFileSessionLog`); wall time lives in `tWall`. Deterministic.
   */
  tSim: z.number().nonnegative(),
  /** Wall-clock time in milliseconds since the epoch. Removed by normalization. */
  tWall: z.number().nonnegative(),
  kind: z.string().min(1),
  payload: z.unknown(),
  contentClass: contentClassSchema,
})

/**
 * Validates the envelope and, for event kinds, the payload through the same
 * schema the engine uses. This is what lets the eval runner trust a transcript file
 * without importing engine code.
 */
export const transcriptRecordSchema = transcriptRecordBaseSchema.superRefine((record, ctx) => {
  if (isSessionEventName(record.kind)) {
    const payloadSchema = eventPayloadSchemas[record.kind] as z.ZodType
    const result = payloadSchema.safeParse(record.payload)
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: 'custom',
          message: issue.message,
          path: ['payload', ...issue.path],
        })
      }
    }
  }

  // Privacy guard at parse/emit time: a text-bearing event may never be
  // classified as public, and an operational event may not claim to be
  // restricted or public. This makes the M0 `contentClassValid` check
  // structural instead of advisory.
  //
  // The rule entered at 1.1.0. Applying it to 1.0.0 records would make a minor
  // bump break old logs, so legacy records stay readable; every new producer
  // writes a current version and is checked.
  if (isTranscriptSchemaAtLeast(record.schemaVersion, CONTENT_CLASS_RULE_SINCE)) {
    if (isSessionEventName(record.kind)) {
      const expected = expectedContentClass(record.kind)
      if (record.contentClass !== expected) {
        ctx.addIssue({
          code: 'custom',
          message: `${record.kind} must be contentClass "${expected}", got "${record.contentClass}"`,
          path: ['contentClass'],
        })
      }
    } else if (record.contentClass === 'public' && !PUBLIC_NON_EVENT_KINDS.has(record.kind)) {
      ctx.addIssue({
        code: 'custom',
        message: `non-event record "${record.kind}" may not be contentClass "public"; use "contentFree" or "restricted"`,
        path: ['contentClass'],
      })
    }
  }
})

export type TranscriptRecord = z.infer<typeof transcriptRecordSchema>

/** A transcript record whose kind is a §2.1 event and whose payload passed validation. */
export type EventTranscriptRecord = TranscriptRecord & {
  readonly kind: SessionEventName
  readonly payload: SessionEventPayload
}

/**
 * Parse an untrusted transcript record.
 *
 * The version is read before the payload is validated. A breaking bump is
 * exactly the case where the payload shape changed, so validating the payload
 * first would report a newer record as corrupt data instead of an unreadable
 * version and bypass the typed migration trigger. Rejecting is the same either
 * way; only the error is different.
 */
export function parseTranscriptRecord(input: unknown): TranscriptRecord {
  const version = readSchemaVersion(input)
  if (
    version !== undefined &&
    majorOfSchemaVersion(version) !== majorOfSchemaVersion(TRANSCRIPT_SCHEMA_VERSION)
  ) {
    throw new TranscriptSchemaVersionError(version, TRANSCRIPT_SCHEMA_VERSION)
  }

  return transcriptRecordSchema.parse(input)
}

/** Read `schemaVersion` without validating the rest of the record. */
function readSchemaVersion(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as { schemaVersion?: unknown }).schemaVersion
  if (typeof value !== 'string') return undefined
  return transcriptSchemaVersionSchema.safeParse(value).success ? value : undefined
}

/**
 * Recover the event from a transcript record. Returns `undefined` for non-event
 * kinds (operational records). Throws if an event payload is invalid; use
 * `parseTranscriptRecord` first when input is untrusted.
 */
export function eventFromTranscriptRecord(record: TranscriptRecord): SessionEvent | undefined {
  if (!isSessionEventName(record.kind)) return undefined

  const payload = (eventPayloadSchemas[record.kind] as z.ZodType).parse(record.payload)
  return { type: record.kind, payload } as SessionEvent
}

/**
 * Value written to `tWall` and `executionId` by normalization.
 *
 * Wall-clock time, execution identity, and the wall-mode `tSim` are the only
 * non-reproducible fields in a transcript (§2.3). `tSim` is deterministic for
 * simulated runs; wall-mode session logs pin it to 0 at write time. Normalization
 * pins `tWall` and `executionId`, so the normalized bytes contain no wall-clock
 * value and no execution-specific identity.
 */
export const NORMALIZED_T_WALL = 0
export const NORMALIZED_EXECUTION_ID = 'normalized'

/** Copy one record with wall-clock time and execution identity removed. */
export function normalizeTranscriptRecord(record: TranscriptRecord): TranscriptRecord {
  return {
    ...record,
    tWall: NORMALIZED_T_WALL,
    executionId: NORMALIZED_EXECUTION_ID,
  }
}

/** Copy records with wall-clock time removed. Does not validate. */
export function normalizeTranscriptRecords(
  records: readonly TranscriptRecord[],
): TranscriptRecord[] {
  return records.map((record) => normalizeTranscriptRecord(record))
}

/**
 * Canonical JSONL for replay comparison (G1): one validated record per line,
 * keys sorted by `canonicalJson`, `tWall` normalized, and a trailing newline.
 *
 * Rejects (throws) non-monotonic `seq` with a `GuardViolationError` and invalid
 * records with a `ZodError`. Identical simulated runs therefore serialize to
 * byte-identical strings; two runs that differ only in wall-clock time do too.
 */
export function normalizedTranscriptJsonl(records: readonly unknown[]): string {
  const parsed = records.map((record) => parseTranscriptRecord(record))
  const sequence = checkTranscriptSequence(parsed)
  enforceGuardResult(sequence, { strict: true })

  if (parsed.length === 0) return ''

  const lines = parsed.map((record) => canonicalJson(normalizeTranscriptRecord(record)))
  return `${lines.join('\n')}\n`
}
