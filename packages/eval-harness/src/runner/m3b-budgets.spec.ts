import { DEFAULT_TURN_ARBITER_CONFIG, TURN_ARBITER_CONFIG_VERSION } from '@rp/turn-arbiter'
import { describe, expect, it } from 'vitest'
import { M3B_BUDGETS, M3B_BUDGET_VERSION } from './m3b-budgets.js'
import { SHADOW_DEADLINE_MS } from './shadow.js'

describe('frozen M3b budgets', () => {
  it('pins the arbiter config and the version it was measured against', () => {
    expect(M3B_BUDGETS.version).toBe(M3B_BUDGET_VERSION)
    expect(M3B_BUDGETS.arbiterConfigVersion).toBe(TURN_ARBITER_CONFIG_VERSION)
    expect(M3B_BUDGETS.turnArbiter).toEqual(DEFAULT_TURN_ARBITER_CONFIG)
    expect(M3B_BUDGETS.turnArbiter).toMatchObject({
      requestWindowMs: 1_500,
      grantTtlMs: 60_000,
      minHoldMs: 800,
      interjectExpiryMs: 1_000,
      interjectCooldownMs: 3_000,
      streakCap: 2,
      replacementAttempts: 1,
      maxConsecutiveFailures: 2,
    })
  })

  it('pins the live task count, MDE, deadline and spend cap', () => {
    expect(M3B_BUDGETS.live).toMatchObject({
      rounds: 3,
      tasksPerLanguage: 12,
      holdoutPerLanguage: 6,
      minimumDetectableEffect: 0.2,
      maxTrialMs: 180_000,
      shadowDeadlineMs: SHADOW_DEADLINE_MS,
      costCapUsd: 5,
    })
    expect(SHADOW_DEADLINE_MS).toBe(2_500)
  })
})
