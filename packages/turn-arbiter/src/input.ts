import { routingContextSchema } from '@rp/routing-policy'
import { grantIdSchema, personaIdSchema, turnIdSchema, turnRequestSchema } from '@rp/session-core'
import { z } from 'zod'
import type { TurnArbiterConfig } from './config.js'
import type { ArbiterInput } from './types.js'

/**
 * Boundary validation for arbiter inputs.
 *
 * The reducer must stay total: a fuzz run and a misbehaving transport can send
 * anything, and a live session must not stop with an error. Every input is
 * parsed here and becomes either a typed `ArbiterInput` or `undefined`, which
 * the reducer drops.
 *
 * Every schema is strict, so an unknown field is treated as a malformed input
 * rather than silently ignored. Every input also carries `nowMs`, and the grant
 * path turns it into an ISO deadline, so a clock the reducer cannot represent
 * is invalid for each kind, including the ones that do not read it.
 */

/**
 * Largest time value a `Date` can represent (ECMA-262 §21.4.1.1).
 */
export const MAX_TIME_VALUE_MS = 8_640_000_000_000_000

/**
 * True when `nowMs` and every deadline derived from it stay inside the `Date`
 * range. `new Date(...).toISOString()` throws a RangeError outside it, so the
 * check runs at the boundary, not in `decide`.
 *
 * The input schemas already reject a non-number, `NaN` and `Infinity`; the
 * comparison below also rejects them, so this helper stays total on its own.
 */
export function isUsableClock(nowMs: number, config: TurnArbiterConfig): boolean {
  const longestLifetime = Math.max(config.requestWindowMs, config.grantTtlMs)
  if (!Number.isFinite(longestLifetime)) return false

  return Math.abs(nowMs) <= MAX_TIME_VALUE_MS - longestLifetime
}

const userCommittedSchema = z.strictObject({
  kind: z.literal('user_committed'),
  turnId: turnIdSchema,
  nowMs: z.number(),
  seed: z.number(),
  context: routingContextSchema,
  eligiblePersonaIds: z.array(personaIdSchema),
})

const requestInputSchema = z.strictObject({
  kind: z.literal('request'),
  request: turnRequestSchema,
  nowMs: z.number(),
})

const declinedSchema = z.strictObject({
  kind: z.literal('declined'),
  turnId: turnIdSchema,
  personaId: personaIdSchema,
  nowMs: z.number(),
})

const tickSchema = z.strictObject({
  kind: z.literal('tick'),
  nowMs: z.number(),
})

const responseEndedSchema = z.strictObject({
  kind: z.literal('response_ended'),
  grantId: grantIdSchema,
  outcome: z.enum(['completed', 'cancelled']),
  nowMs: z.number(),
})

const closeSchema = z.strictObject({
  kind: z.literal('close'),
  nowMs: z.number(),
})

const arbiterInputSchema = z.discriminatedUnion('kind', [
  userCommittedSchema,
  requestInputSchema,
  declinedSchema,
  tickSchema,
  responseEndedSchema,
  closeSchema,
])

/**
 * Parse one transport input into a reducer input, or `undefined` to drop it.
 *
 * A non-object, an unknown `kind`, a missing or extra field, a malformed
 * routing context, a malformed request and an unusable clock all end here.
 */
export function parseArbiterInput(
  input: unknown,
  config: TurnArbiterConfig,
): ArbiterInput | undefined {
  const parsed = arbiterInputSchema.safeParse(input)
  if (!parsed.success) return undefined
  if (!isUsableClock(parsed.data.nowMs, config)) return undefined

  return parsed.data
}
