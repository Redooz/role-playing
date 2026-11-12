import { z } from 'zod'

/**
 * Turn-arbiter configuration (M3b D2).
 *
 * The provisional values come from the M3b plan §6.4. They are measured and
 * frozen in D6; until then they are the declared defaults, not calibrated
 * numbers. A later change needs a calibration note.
 */

export const TURN_ARBITER_CONFIG_VERSION = 'm3b-turn-arbiter-config-v2'

export const turnArbiterConfigSchema = z.strictObject({
  /** Bounded window that collects one turn request per eligible persona. */
  requestWindowMs: z.int().positive().default(1_500),
  /** Grant lifetime. The driver uses the same value for its grant bookkeeping. */
  grantTtlMs: z.int().positive().default(60_000),
  /** How long a grant holder speaks before another persona may interject. */
  minHoldMs: z.int().nonnegative().default(800),
  /** Bounded opportunity to interject, opening after `minHoldMs`. */
  interjectExpiryMs: z.int().positive().default(1_000),
  /** A persona that interjected cannot interject again inside this window. */
  interjectCooldownMs: z.int().nonnegative().default(3_000),
  /**
   * Consecutive agent-only grants (a replacement or an interjection) allowed
   * without a new user utterance. At the cap the arbiter hands the turn back.
   */
  streakCap: z.int().nonnegative().default(2),
  /** Bounded fallback grants after a grant holder fails before output. */
  replacementAttempts: z.int().nonnegative().default(1),
  /** Consecutive provider failures that close the session cleanly. */
  maxConsecutiveFailures: z.int().positive().default(2),
})

export type TurnArbiterConfig = z.infer<typeof turnArbiterConfigSchema>

/** Parse a partial config over the declared defaults; unknown keys are rejected. */
export function parseTurnArbiterConfig(value: unknown = {}): TurnArbiterConfig {
  return turnArbiterConfigSchema.parse(value)
}

export const DEFAULT_TURN_ARBITER_CONFIG: TurnArbiterConfig =
  Object.freeze(parseTurnArbiterConfig())
