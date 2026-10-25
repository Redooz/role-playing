import { describe, expect, it } from 'vitest'
import { canonicalJson, hashValue, sha256Hex } from './canonical.js'

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
  })

  it('omits undefined object properties but keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}')
  })

  it('is independent of insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }))
  })

  it('rejects circular structures', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => canonicalJson(circular)).toThrow(/circular/)
  })

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite/)
  })

  it('rejects values JSON cannot represent', () => {
    expect(() => canonicalJson({ a: 1n })).toThrow(/bigint/)
  })
})

describe('hashValue', () => {
  it('is stable for the same logical payload', () => {
    expect(hashValue({ b: 1, a: 2 })).toBe(hashValue({ a: 2, b: 1 }))
  })

  it('changes when a value changes', () => {
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }))
  })

  it('matches sha256Hex of the canonical form', () => {
    expect(hashValue({ a: 1 })).toBe(sha256Hex('{"a":1}'))
  })
})
