import { describe, expect, it } from 'vitest'
import { labelClass, type LabelClassInput } from './label-class.js'

function label(overrides: Partial<LabelClassInput> = {}): LabelClassInput {
  return { acceptablePersonaIds: ['peer'], allowUserYield: false, ...overrides }
}

describe('labelClass', () => {
  it('requires a speaker when personas are accepted and learner yield is not', () => {
    expect(labelClass(label())).toBe('speak')
  })

  it('requires a speaker for two accepted personas', () => {
    expect(labelClass(label({ acceptablePersonaIds: ['manager', 'peer'] }))).toBe('speak')
  })

  it('requires silence when no persona is accepted and learner yield is allowed', () => {
    expect(labelClass(label({ acceptablePersonaIds: [], allowUserYield: true }))).toBe('silence')
  })

  it('marks a label that accepts both a persona and learner yield as mixed', () => {
    expect(labelClass(label({ allowUserYield: true }))).toBe('mixed')
  })

  it('marks a two-persona label that also allows learner yield as mixed', () => {
    expect(
      labelClass(label({ acceptablePersonaIds: ['manager', 'peer'], allowUserYield: true })),
    ).toBe('mixed')
  })

  it('rejects the label that accepts neither, as the schemas do', () => {
    expect(() => labelClass(label({ acceptablePersonaIds: [], allowUserYield: false }))).toThrow(
      /at least one persona or learner yield/u,
    )
  })
})
