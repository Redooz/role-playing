import { describe, expect, it } from 'vitest'
import { makeContext } from './fixtures.js'
import { interpretCentralJudgment, interpretCentralJudgmentForContext } from './jev.js'

describe('interpretCentralJudgment', () => {
  it('accepts a valid probability and eligible persona id', () => {
    expect(
      interpretCentralJudgment({ anyoneWarranted: 0.82, selectedPersonaId: 'peer' }, [
        'manager',
        'peer',
      ]),
    ).toEqual({
      ok: true,
      anyoneWarranted: 0.82,
      selectedPersonaId: 'peer',
    })
  })

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid probability (%s)',
    (anyoneWarranted) => {
      expect(
        interpretCentralJudgment({ anyoneWarranted, selectedPersonaId: 'peer' }, ['peer']),
      ).toEqual({
        ok: false,
        reason: 'invalid_probability',
      })
    },
  )

  it('rejects an empty or ineligible persona id', () => {
    expect(
      interpretCentralJudgment({ anyoneWarranted: 0.5, selectedPersonaId: '' }, ['peer']),
    ).toEqual({
      ok: false,
      reason: 'unknown_persona',
    })
    expect(
      interpretCentralJudgment({ anyoneWarranted: 0.5, selectedPersonaId: 'ghost' }, ['peer']),
    ).toEqual({
      ok: false,
      reason: 'unknown_persona',
    })
  })

  it('accepts the boundary probabilities', () => {
    expect(
      interpretCentralJudgment({ anyoneWarranted: 0, selectedPersonaId: 'peer' }, ['peer']).ok,
    ).toBe(true)
    expect(
      interpretCentralJudgment({ anyoneWarranted: 1, selectedPersonaId: 'peer' }, ['peer']).ok,
    ).toBe(true)
  })
})

describe('interpretCentralJudgmentForContext', () => {
  it('accepts an eligible persona', () => {
    expect(
      interpretCentralJudgmentForContext(makeContext(), {
        anyoneWarranted: 0.8,
        selectedPersonaId: 'client',
      }),
    ).toMatchObject({ ok: true, selectedPersonaId: 'client' })
  })

  it('rejects a persona outside the eligible set', () => {
    expect(
      interpretCentralJudgmentForContext(makeContext(), {
        anyoneWarranted: 0.8,
        selectedPersonaId: 'ghost',
      }),
    ).toEqual({ ok: false, reason: 'unknown_persona' })
  })

  it('passes through an invalid probability before checking the persona', () => {
    expect(
      interpretCentralJudgmentForContext(makeContext(), {
        anyoneWarranted: 2,
        selectedPersonaId: 'ghost',
      }),
    ).toEqual({ ok: false, reason: 'invalid_probability' })
  })
})
