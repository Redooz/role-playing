import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TURN_ARBITER_CONFIG,
  TURN_ARBITER_CONFIG_VERSION,
  parseTurnArbiterConfig,
} from './config.js'

describe('turn arbiter config', () => {
  it('has versioned declared defaults from the plan', () => {
    expect(TURN_ARBITER_CONFIG_VERSION).toBe('m3b-turn-arbiter-config-v2')
    expect(DEFAULT_TURN_ARBITER_CONFIG).toEqual({
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

  it('fills missing fields from the defaults', () => {
    expect(parseTurnArbiterConfig({ requestWindowMs: 2_000 })).toEqual({
      ...DEFAULT_TURN_ARBITER_CONFIG,
      requestWindowMs: 2_000,
    })
  })

  it('accepts a zero hold, cooldown, streak cap or replacement budget', () => {
    expect(
      parseTurnArbiterConfig({
        minHoldMs: 0,
        interjectCooldownMs: 0,
        streakCap: 0,
        replacementAttempts: 0,
      }),
    ).toEqual({
      ...DEFAULT_TURN_ARBITER_CONFIG,
      minHoldMs: 0,
      interjectCooldownMs: 0,
      streakCap: 0,
      replacementAttempts: 0,
    })
  })

  it('rejects unknown, non-integer and non-positive values', () => {
    expect(() => parseTurnArbiterConfig({ unknown: 1 })).toThrow()

    const nonInteger = [
      'requestWindowMs',
      'grantTtlMs',
      'minHoldMs',
      'interjectExpiryMs',
      'interjectCooldownMs',
      'streakCap',
      'replacementAttempts',
      'maxConsecutiveFailures',
    ]
    for (const field of nonInteger) {
      expect(() => parseTurnArbiterConfig({ [field]: 1.5 })).toThrow()
      expect(() => parseTurnArbiterConfig({ [field]: -1 })).toThrow()
    }

    const mustBePositive = [
      'requestWindowMs',
      'grantTtlMs',
      'interjectExpiryMs',
      'maxConsecutiveFailures',
    ]
    for (const field of mustBePositive) {
      expect(() => parseTurnArbiterConfig({ [field]: 0 })).toThrow()
    }
  })
})
