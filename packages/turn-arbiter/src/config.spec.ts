import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TURN_ARBITER_CONFIG,
  TURN_ARBITER_CONFIG_VERSION,
  parseTurnArbiterConfig,
} from './config.js'

describe('turn arbiter config', () => {
  it('has versioned declared defaults', () => {
    expect(TURN_ARBITER_CONFIG_VERSION).toBe('m3b-turn-arbiter-config-v1')
    expect(DEFAULT_TURN_ARBITER_CONFIG).toEqual({
      requestWindowMs: 1_500,
      grantTtlMs: 60_000,
    })
  })

  it('fills missing fields from the defaults', () => {
    expect(parseTurnArbiterConfig({ requestWindowMs: 2_000 })).toEqual({
      requestWindowMs: 2_000,
      grantTtlMs: 60_000,
    })
  })

  it('rejects unknown, non-integer and non-positive values', () => {
    expect(() => parseTurnArbiterConfig({ unknown: 1 })).toThrow()
    expect(() => parseTurnArbiterConfig({ requestWindowMs: 1.5 })).toThrow()
    expect(() => parseTurnArbiterConfig({ grantTtlMs: 0 })).toThrow()
    expect(() => parseTurnArbiterConfig({ requestWindowMs: -1 })).toThrow()
  })
})
