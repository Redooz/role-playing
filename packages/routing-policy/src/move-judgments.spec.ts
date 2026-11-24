import { describe, expect, it } from 'vitest'
import {
  routingMoveJudgmentsRecordSchema,
  routingMoveJudgmentsSchema,
  routingPersonaMoveJudgmentsSchema,
} from './move-judgments.js'

const quiet = {
  closingMove: 0.1,
  selfAnswer: 0.2,
  thinkingAloud: 0.3,
  sideComment: 0.4,
}

describe('routingMoveJudgmentsSchema', () => {
  it('accepts a probability in the closed unit interval', () => {
    expect(routingMoveJudgmentsSchema.parse(quiet)).toEqual(quiet)
    expect(
      routingMoveJudgmentsSchema.parse({
        closingMove: 0,
        selfAnswer: 1,
        thinkingAloud: 0.5,
        sideComment: 0,
      }),
    ).toMatchObject({ closingMove: 0, selfAnswer: 1 })
  })

  it('rejects a probability outside the unit interval', () => {
    expect(() => routingMoveJudgmentsSchema.parse({ ...quiet, selfAnswer: -0.1 })).toThrow()
    expect(() => routingMoveJudgmentsSchema.parse({ ...quiet, selfAnswer: 1.1 })).toThrow()
  })

  it('rejects a missing or extra move', () => {
    const { sideComment: _omitted, ...withoutSideComment } = quiet
    expect(() => routingMoveJudgmentsSchema.parse(withoutSideComment)).toThrow()
    expect(() => routingMoveJudgmentsSchema.parse({ ...quiet, extra: 0.5 })).toThrow()
  })
})

describe('routingPersonaMoveJudgmentsSchema', () => {
  it('adds direct address to the four moves', () => {
    expect(
      routingPersonaMoveJudgmentsSchema.parse({ ...quiet, directlyAddressed: 0 }),
    ).toMatchObject({ directlyAddressed: 0 })
    expect(
      routingPersonaMoveJudgmentsSchema.parse({ ...quiet, directlyAddressed: 1 }),
    ).toMatchObject({ directlyAddressed: 1 })
  })

  it('requires direct address', () => {
    expect(() => routingPersonaMoveJudgmentsSchema.parse(quiet)).toThrow(/directlyAddressed/i)
  })
})

describe('routingMoveJudgmentsRecordSchema', () => {
  it('accepts a central record', () => {
    expect(routingMoveJudgmentsRecordSchema.parse({ scope: 'central', move: quiet })).toEqual({
      scope: 'central',
      move: quiet,
    })
  })

  it('accepts persona records keyed by persona id', () => {
    const record = {
      scope: 'persona',
      byPersona: { peer: { ...quiet, directlyAddressed: 1 } },
    }
    expect(routingMoveJudgmentsRecordSchema.parse(record)).toEqual(record)
  })

  it('rejects an empty persona key and an unknown scope', () => {
    expect(() =>
      routingMoveJudgmentsRecordSchema.parse({
        scope: 'persona',
        byPersona: { '': { ...quiet, directlyAddressed: 0 } },
      }),
    ).toThrow()
    expect(() => routingMoveJudgmentsRecordSchema.parse({ scope: 'other', move: quiet })).toThrow()
  })
})
