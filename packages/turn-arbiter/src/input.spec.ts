import { describe, expect, it } from 'vitest'
import { parseTurnArbiterConfig } from './config.js'
import { makeTurnContext } from './fixtures.js'
import { isUsableClock, MAX_TIME_VALUE_MS, parseArbiterInput } from './input.js'

const CONFIG = parseTurnArbiterConfig({
  requestWindowMs: 1_000,
  grantTtlMs: 5_000,
  minHoldMs: 800,
  interjectExpiryMs: 1_000,
})

const INPUTS = {
  committed: {
    kind: 'user_committed',
    turnId: 'turn-1',
    nowMs: 0,
    seed: 7,
    context: makeTurnContext(),
    eligiblePersonaIds: ['manager', 'peer'],
  },
  request: {
    kind: 'request',
    request: {
      turnId: 'turn-1',
      personaId: 'peer',
      action: 'speak',
      urgency: 0.5,
      confidence: 0.5,
      addressedByUser: false,
      objectiveRelevance: 0.5,
    },
    nowMs: 10,
  },
  interject: {
    kind: 'request',
    request: {
      turnId: 'turn-1',
      personaId: 'manager',
      action: 'interject',
      urgency: 0.5,
      confidence: 0.5,
      addressedByUser: false,
      objectiveRelevance: 0.5,
      targetGrantId: 'grant:turn-1:1',
    },
    nowMs: 820,
  },
  declined: { kind: 'declined', turnId: 'turn-1', personaId: 'peer', nowMs: 10 },
  policyFailed: {
    kind: 'policy_failed',
    personaId: 'peer',
    cause: 'timeout',
    nowMs: 10,
  },
  partial: {
    kind: 'partial',
    grantId: 'grant:turn-1:1',
    text: 'Hello',
    sequence: 0,
    nowMs: 30,
  },
  bargeIn: { kind: 'user_barge_in', nowMs: 30 },
  tick: { kind: 'tick', nowMs: 30 },
  responseEnded: {
    kind: 'response_ended',
    grantId: 'grant:turn-1:1',
    outcome: 'completed',
    nowMs: 30,
  },
  close: { kind: 'close', nowMs: 30 },
}

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

  it('accounts for the hold and interject opportunity in the longest lifetime', () => {
    const longHold = { ...CONFIG, minHoldMs: 4_000, interjectExpiryMs: 2_000 }
    expect(isUsableClock(MAX_TIME_VALUE_MS - 5_001, longHold)).toBe(false)
    expect(isUsableClock(MAX_TIME_VALUE_MS - 6_001, longHold)).toBe(true)
  })

  it('rejects every clock when the config lifetime is negative infinity', () => {
    expect(
      isUsableClock(0, {
        ...CONFIG,
        requestWindowMs: -Infinity,
        grantTtlMs: -Infinity,
        minHoldMs: -Infinity,
        interjectExpiryMs: -Infinity,
      }),
    ).toBe(false)
  })

  it('rejects every clock when the config lifetime is not finite', () => {
    expect(isUsableClock(0, { ...CONFIG, requestWindowMs: NaN })).toBe(false)
    expect(isUsableClock(0, { ...CONFIG, grantTtlMs: Infinity })).toBe(false)
    expect(isUsableClock(0, { ...CONFIG, minHoldMs: Infinity })).toBe(false)
    expect(isUsableClock(0, { ...CONFIG, interjectExpiryMs: NaN })).toBe(false)
  })
})

describe('arbiter input parsing', () => {
  it('keeps every well-formed kind', () => {
    for (const input of Object.values(INPUTS)) {
      expect(parseArbiterInput(input, CONFIG)).toEqual(input)
    }
  })

  it('keeps every response outcome', () => {
    for (const outcome of ['completed', 'cancelled', 'failed'] as const) {
      expect(parseArbiterInput({ ...INPUTS.responseEnded, outcome }, CONFIG)).toEqual({
        ...INPUTS.responseEnded,
        outcome,
      })
    }
  })

  it('keeps every policy failure cause', () => {
    for (const cause of ['timeout', 'error'] as const) {
      expect(parseArbiterInput({ ...INPUTS.policyFailed, cause }, CONFIG)).toEqual({
        ...INPUTS.policyFailed,
        cause,
      })
    }
  })

  it('drops a non-number clock before the clock check runs for every kind', () => {
    for (const input of Object.values(INPUTS)) {
      for (const nowMs of [undefined, null, '10', {}, []]) {
        expect(parseArbiterInput({ ...input, nowMs }, CONFIG)).toBeUndefined()
      }
    }
  })

  it('drops an input with an unknown field', () => {
    expect(parseArbiterInput({ ...INPUTS.committed, unexpected: true }, CONFIG)).toBeUndefined()
    expect(parseArbiterInput({ ...INPUTS.partial, unexpected: true }, CONFIG)).toBeUndefined()
  })

  it('drops a malformed partial', () => {
    expect(parseArbiterInput({ ...INPUTS.partial, sequence: -1 }, CONFIG)).toBeUndefined()
    expect(parseArbiterInput({ ...INPUTS.partial, sequence: 1.5 }, CONFIG)).toBeUndefined()
    expect(parseArbiterInput({ ...INPUTS.partial, text: 42 }, CONFIG)).toBeUndefined()
    expect(parseArbiterInput({ ...INPUTS.partial, grantId: '' }, CONFIG)).toBeUndefined()
  })

  it('drops an unknown policy cause and an unknown response outcome', () => {
    expect(parseArbiterInput({ ...INPUTS.policyFailed, cause: 'oops' }, CONFIG)).toBeUndefined()
    expect(parseArbiterInput({ ...INPUTS.responseEnded, outcome: 'bogus' }, CONFIG)).toBeUndefined()
  })

  it('drops an unknown kind and a non-object input', () => {
    expect(parseArbiterInput({ kind: 'nope', nowMs: 0 }, CONFIG)).toBeUndefined()
    expect(parseArbiterInput(null, CONFIG)).toBeUndefined()
    expect(parseArbiterInput('close', CONFIG)).toBeUndefined()
  })
})
