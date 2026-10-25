import { describe, expect, it } from 'vitest'
import { createSeededRandom } from './random.js'

describe('createSeededRandom', () => {
  it('replays the same sequence for the same seed', () => {
    const a = createSeededRandom(42)
    const b = createSeededRandom(42)
    const left = Array.from({ length: 5 }, () => a.next())
    const right = Array.from({ length: 5 }, () => b.next())
    expect(left).toEqual(right)
  })

  it('produces a different sequence for a different seed', () => {
    const a = createSeededRandom(1)
    const b = createSeededRandom(2)
    expect(a.next()).not.toBe(b.next())
  })

  it('stays within [0, 1)', () => {
    const random = createSeededRandom(7)
    for (let i = 0; i < 1000; i += 1) {
      const value = random.next()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('returns integers below the bound', () => {
    const random = createSeededRandom(11)
    for (let i = 0; i < 500; i += 1) {
      const value = random.int(6)
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(6)
    }
  })

  it('rejects invalid bounds and seeds', () => {
    expect(() => createSeededRandom(1.5)).toThrow(TypeError)
    const random = createSeededRandom(1)
    expect(() => random.int(0)).toThrow(RangeError)
  })

  it('bool respects a probability of 0 and 1', () => {
    const random = createSeededRandom(3)
    expect(random.bool(0)).toBe(false)
    expect(random.bool(1)).toBe(true)
  })
})
