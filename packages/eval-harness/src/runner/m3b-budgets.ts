import { DEFAULT_TURN_ARBITER_CONFIG, TURN_ARBITER_CONFIG_VERSION } from '@rp/turn-arbiter'
import { SHADOW_DEADLINE_MS } from './shadow.js'

/**
 * Frozen M3b config and budget table (D6).
 *
 * These are measurement commitments, not tuning knobs. A later change needs a
 * calibration note and a new version, exactly like a prompt or rubric change.
 */
export const M3B_BUDGET_VERSION = 'm3b-budgets-v1'

export const M3B_BUDGETS = Object.freeze({
  version: M3B_BUDGET_VERSION,
  arbiterConfigVersion: TURN_ARBITER_CONFIG_VERSION,
  turnArbiter: Object.freeze({ ...DEFAULT_TURN_ARBITER_CONFIG }),
  live: Object.freeze({
    /** Three rounds over 12 tasks per base language (6 holdout), for pass^3. */
    rounds: 3,
    tasksPerLanguage: 12,
    holdoutPerLanguage: 6,
    /** Pre-registered capability MDE. Smaller deltas are not signal. */
    minimumDetectableEffect: 0.2,
    /** A trial that exceeds this is incomplete, never a quality zero. */
    maxTrialMs: 180_000,
    /** Shadow decisions use the M3a deadline; it is not a live turn deadline. */
    shadowDeadlineMs: SHADOW_DEADLINE_MS,
    /**
     * Total live spend cap for M3b. The shadow script checks only its own
     * records; the eval runner does not meter capability cost, so the combined
     * total is recorded as unmeasured rather than guessed.
     */
    costCapUsd: 5,
  }),
})
