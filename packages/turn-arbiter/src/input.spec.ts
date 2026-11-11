import { describe, expect, it } from 'vitest'
import { parseTurnArbiterConfig } from './config.js'
import { makeTurnContext } from './fixtures.js'
import { isUsableClock, MAX_TIME_VALUE_MS, parseArbiterInput } from './input.js'

const CONFIG = parseTurnArbiterConfig({ requestWindowMs: 1_000, grantTtlMs: 5_000 })

describe('arbiter clock validation', () => {
  it('accepts a clock whose deadlines stay inside the Date range', () => {
    expect(isUsableClock(0, CONFIG)).toBe(true)
    expect(isUsableClock(-1_000, CONFIG)).toBe(true)
    expect(isUsableClock(MAX_TIME_VALUE_MS - 5_000, CONFIG)).toBe(true)
  })

  it('rejects a clock whose deadline would overflow the Date range', () => {
    expect(isUsableClock(MAX_TIME_VALUE_MS - 4_999, CONFIG)).toBe(false)
    expect(isUsableClock(-(MAX_TIME_VALUE_MS - 4_999), CONFIG)).toBe(false)
  })

  it('rejects a non-finite clock', () => {
    expect(isUsableClock(NaN, CONFIG)).toBe(false)
    expect(isUsableClock(Infinity, CONFIG)).toBe(false)
    expect(isUsableClock(-Infinity, CONFIG)).toBe(false)
  })

  it('rejects every clock when the config lifetime is not finite', () => {
    expect(isUsableClock(0, { requestWindowMs: -Infinity, grantTtlMs: -Infinity })).toBe(false)
    expect(isUsableClock(0, { requestWindowMs: Infinity, grantTtlMs: 5_000 })).toBe(false)
    expect(isUsableClock(0, { requestWindowMs: 1_000, grantTtlMs: NaN })).toBe(false)
  })
})

describe('arbiter input parsing', () => {
  const committed = {
    kind: 'user_committed',
    turnId: 'turn-1',
    nowMs: 0,
    seed: 7,
    context: makeTurnContext(),
    eligiblePersonaIds: ['manager'],
  }

  it('keeps a well-formed input', () => {
    expect(parseArbiterInput(committed, CONFIG)).toEqual(committed)
  })

  it('drops a non-number clock before the clock check runs', () => {
    for (const nowMs of [undefined, null, '10', {}, []]) {
      expect(parseArbiterInput({ ...committed, nowMs }, CONFIG)).toBeUndefined()
    }
  })

  it('drops an input with an unknown field', () => {
    expect(parseArbiterInput({ ...committed, unexpected: true }, CONFIG)).toBeUndefined()
  })

  it('drops an unknown kind and a non-object input', () => {
    expect(parseArbiterInput({ kind: 'nope', nowMs: 0 }, CONFIG)).toBeUndefined()
    expect(parseArbiterInput(null, CONFIG)).toBeUndefined()
    expect(parseArbiterInput('close', CONFIG)).toBeUndefined()
  })
})
