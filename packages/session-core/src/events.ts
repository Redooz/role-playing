import { z } from 'zod'

/**
 * Event and payload schemas for the shared event vocabulary in Architecture
 * Plan v5 §2.1 and the grant contract in §3.2.
 *
 * These are *wire* shapes: everything here must survive JSON serialization
 * unchanged so a trace can be replayed byte-for-byte. Timestamps are therefore
 * ISO-8601 UTC strings, not `Date` instances, and every object is strict:
 * unknown fields are rejected rather than silently dropped. Adding a field is
 * an additive change covered by the versioning policy in `version.ts`.
 */

export const personaIdSchema = z.string().min(1)
export const turnIdSchema = z.string().min(1)
export const grantIdSchema = z.string().min(1)

export type PersonaId = z.infer<typeof personaIdSchema>
export type TurnId = z.infer<typeof turnIdSchema>
export type GrantId = z.infer<typeof grantIdSchema>

/**
 * §3.2 `TurnGrant`. `expiresAt` is ISO-8601 UTC because the trace record is
 * JSON; the engine converts from its (fake) clock before emitting `turn.granted`.
 */
export const turnGrantSchema = z.strictObject({
  turnId: turnIdSchema,
  grantId: grantIdSchema,
  personaId: personaIdSchema,
  expiresAt: z.iso.datetime({ offset: false }),
})

export type TurnGrant = z.infer<typeof turnGrantSchema>

/**
 * §3.2 `TurnRequest`. Scores are probabilities in `[0, 1]`.
 *
 * `targetGrantId` is only meaningful for `action: "interject"`, where §3.2/§3.4
 * make it required.
 */
export const turnRequestSchema = z
  .strictObject({
    turnId: turnIdSchema,
    personaId: personaIdSchema,
    action: z.enum(['speak', 'interject']),
    urgency: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    addressedByUser: z.boolean(),
    objectiveRelevance: z.number().min(0).max(1),
    targetGrantId: grantIdSchema.optional(),
  })
  .refine((request) => request.action !== 'interject' || request.targetGrantId !== undefined, {
    message: 'targetGrantId is required when action is "interject"',
    path: ['targetGrantId'],
  })

export type TurnRequest = z.infer<typeof turnRequestSchema>

/**
 * Why a grant was revoked. The plan requires the reason but does not enumerate
 * values; this list covers the transitions in §3.3–§3.5 and is part of the
 * schema we validate, not free text (free text could leak content into traces).
 */
export const revocationReasonSchema = z.enum([
  'completed',
  'cancelled',
  'timeout',
  'interrupted',
  'user_barge_in',
  'provider_failure',
  'session_completed',
])

export type RevocationReason = z.infer<typeof revocationReasonSchema>

/**
 * Why the turn was handed back to the user. Mirrors the §3.5 recovery matrix:
 * every persona declined, every policy failed, the agent-only streak cap was
 * reached, or the single replacement attempt also failed.
 */
export const userYieldReasonSchema = z.enum([
  'all_declined',
  'policy_timeout',
  'streak_cap',
  'replacement_failed',
])

export type UserYieldReason = z.infer<typeof userYieldReasonSchema>

/** Why an in-flight response stopped; matches the revocation causes above. */
export const responseCancellationReasonSchema = z.enum([
  'interrupted',
  'user_barge_in',
  'timeout',
  'provider_failure',
  'revoked',
])

export type ResponseCancellationReason = z.infer<typeof responseCancellationReasonSchema>

/* ------------------------------------------------------------------------- */
/* §2.1 payloads                                                             */
/* ------------------------------------------------------------------------- */

/**
 * The user began producing input (first keystroke in raw mode, first STT
 * partial later). It carries no text: the committed utterance does.
 */
export const userStartedSpeakingPayloadSchema = z.strictObject({})

export const userUtteranceCommittedPayloadSchema = z.strictObject({
  text: z.string(),
})

export const userBargeInPayloadSchema = z.strictObject({
  /** The grant the user talked over, when the engine already knows it. */
  targetGrantId: grantIdSchema.optional(),
})

/** `turn.opened` opens the bounded request window keyed by `turnId` (§3.3). */
export const turnOpenedPayloadSchema = z.strictObject({
  turnId: turnIdSchema,
})

export const personaRequestedTurnPayloadSchema = z.strictObject({
  request: turnRequestSchema,
})

export const personaDeclinedPayloadSchema = z.strictObject({
  turnId: turnIdSchema,
  personaId: personaIdSchema,
})

/** §3.2: `turn.granted { grant }`. */
export const turnGrantedPayloadSchema = z.strictObject({
  grant: turnGrantSchema,
})

/** §3.2: `turn.revoked { grantId, reason }`. */
export const turnRevokedPayloadSchema = z.strictObject({
  grantId: grantIdSchema,
  reason: revocationReasonSchema,
})

/** §3.2: `turn.user_yielded { reason }`. */
export const turnUserYieldedPayloadSchema = z.strictObject({
  reason: userYieldReasonSchema,
})

/** §3.2: `persona.response.*` always names the grant it is publishing under. */
export const personaResponseStartedPayloadSchema = z.strictObject({
  grantId: grantIdSchema,
})

export const personaResponseChunkPayloadSchema = z.strictObject({
  grantId: grantIdSchema,
  text: z.string(),
  sequence: z.int().nonnegative(),
})

export const personaResponseCommittedPayloadSchema = z.strictObject({
  grantId: grantIdSchema,
  text: z.string(),
})

export const personaResponseCancelledPayloadSchema = z.strictObject({
  grantId: grantIdSchema,
  reason: responseCancellationReasonSchema,
  /** Partial text is preserved as interrupted context (§2.1), never silently lost. */
  partialText: z.string().optional(),
})

/** §3.2/§3.4: partials carry per-response sequence numbers for stale detection. */
export const personaUtterancePartialPayloadSchema = z.strictObject({
  grantId: grantIdSchema,
  text: z.string(),
  sequence: z.int().nonnegative(),
})

/** No required payload beyond the event itself; session totals belong in evals. */
export const sessionCompletedPayloadSchema = z.strictObject({})

/* ------------------------------------------------------------------------- */
/* Event name → payload schema                                               */
/* ------------------------------------------------------------------------- */

/**
 * The complete §2.1 vocabulary. Keys are the exact event names; tools that only
 * need to check "is this kind an event?" use `isSessionEventName`.
 */
export const eventPayloadSchemas = {
  'user.started_speaking': userStartedSpeakingPayloadSchema,
  'user.utterance.committed': userUtteranceCommittedPayloadSchema,
  'user.barge_in': userBargeInPayloadSchema,
  'persona.utterance.partial': personaUtterancePartialPayloadSchema,
  'turn.opened': turnOpenedPayloadSchema,
  'persona.requested_turn': personaRequestedTurnPayloadSchema,
  'persona.declined': personaDeclinedPayloadSchema,
  'turn.granted': turnGrantedPayloadSchema,
  'turn.revoked': turnRevokedPayloadSchema,
  'turn.user_yielded': turnUserYieldedPayloadSchema,
  'persona.response.started': personaResponseStartedPayloadSchema,
  'persona.response.chunk': personaResponseChunkPayloadSchema,
  'persona.response.committed': personaResponseCommittedPayloadSchema,
  'persona.response.cancelled': personaResponseCancelledPayloadSchema,
  'session.completed': sessionCompletedPayloadSchema,
} as const

export type SessionEventName = keyof typeof eventPayloadSchemas

/** Payload type for one event name, inferred from its Zod schema. */
export type EventPayloadFor<Name extends SessionEventName> = z.infer<
  (typeof eventPayloadSchemas)[Name]
>

/** Union of every event payload. */
export type SessionEventPayload = EventPayloadFor<SessionEventName>

/** Payload types keyed by the exact event name. */
export type SessionEventPayloadMap = {
  [Name in SessionEventName]: EventPayloadFor<Name>
}

/**
 * Discriminated union of all events. The discriminator is `type` and the
 * validated payload sits under `payload`, matching `TraceRecord.kind`/`payload`.
 */
export const sessionEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('user.started_speaking'),
    payload: userStartedSpeakingPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('user.utterance.committed'),
    payload: userUtteranceCommittedPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('user.barge_in'),
    payload: userBargeInPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('persona.utterance.partial'),
    payload: personaUtterancePartialPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('turn.opened'),
    payload: turnOpenedPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('persona.requested_turn'),
    payload: personaRequestedTurnPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('persona.declined'),
    payload: personaDeclinedPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('turn.granted'),
    payload: turnGrantedPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('turn.revoked'),
    payload: turnRevokedPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('turn.user_yielded'),
    payload: turnUserYieldedPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('persona.response.started'),
    payload: personaResponseStartedPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('persona.response.chunk'),
    payload: personaResponseChunkPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('persona.response.committed'),
    payload: personaResponseCommittedPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('persona.response.cancelled'),
    payload: personaResponseCancelledPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('session.completed'),
    payload: sessionCompletedPayloadSchema,
  }),
])

export type SessionEvent = z.infer<typeof sessionEventSchema>

/** Narrow the event union to one event name (used by guards and the engine). */
export type SessionEventOf<Name extends SessionEventName> = Extract<SessionEvent, { type: Name }>

/** Event names in §2.1 order. */
export const sessionEventNames = Object.keys(eventPayloadSchemas) as readonly SessionEventName[]

/** Runtime check that `kind` is one of the §2.1 event names. */
export function isSessionEventName(kind: string): kind is SessionEventName {
  return Object.hasOwn(eventPayloadSchemas, kind)
}

/** Parse and validate an event from untrusted input (fixtures, JSONL traces). */
export function parseSessionEvent(input: unknown): SessionEvent {
  return sessionEventSchema.parse(input)
}
