import { describe, expect, it } from 'vitest'

import { percentile, quantileOfSorted, summarizeDurations } from './percentiles.js'

describe('summarizeDurations', () => {
  it('summarizes a small sample with interpolated percentiles', () => {
    expect(summarizeDurations([1, 2, 3, 4, 5])).toEqual({
      count: 5,
      min: 1,
      max: 5,
      mean: 3,
      p50: 3,
      p95: 4.8,
      p99: 4.96,
    })
  })

  it('handles a single sample', () => {
    expect(summarizeDurations([42])).toEqual({
      count: 1,
      min: 42,
      max: 42,
      mean: 42,
      p50: 42,
      p95: 42,
      p99: 42,
    })
  })

  it('interpolates between ranks for a two-value sample', () => {
    const summary = summarizeDurations([10, 20])

    expect(summary.p50).toBe(15)
    expect(summary.p95).toBeCloseTo(19.5, 10)
    expect(summary.p99).toBeCloseTo(19.9, 10)
  })

  it('stays correct for large N', () => {
    const sample = Array.from({ length: 1_000 }, (_, index) => index + 1)
    const summary = summarizeDurations(sample)

    expect(summary.count).toBe(1_000)
    expect(summary.min).toBe(1)
    expect(summary.max).toBe(1_000)
    expect(summary.mean).toBe(500.5)
    expect(summary.p50).toBe(500.5)
    expect(summary.p95).toBeCloseTo(950.05, 10)
    expect(summary.p99).toBeCloseTo(990.01, 10)
  })

  it('sorts a copy without mutating the caller array', () => {
    const sample = [5, 1, 3, 2, 4]

    expect(summarizeDurations(sample).p50).toBe(3)
    expect(sample).toEqual([5, 1, 3, 2, 4])
  })

  it('rejects empty and non-finite samples', () => {
    expect(() => summarizeDurations([])).toThrow(RangeError)
    expect(() => summarizeDurations([1, Number.NaN])).toThrow(TypeError)
    expect(() => summarizeDurations([1, Number.POSITIVE_INFINITY])).toThrow(TypeError)
  })

  it('names the empty sample and the offending non-finite value', () => {
    expect(() => summarizeDurations([])).toThrow(new RangeError('Cannot summarize an empty sample'))
    expect(() => summarizeDurations([1, Number.NaN])).toThrow(
      new TypeError('Durations must be finite numbers, received: NaN'),
    )
    expect(() => summarizeDurations([1, Number.NEGATIVE_INFINITY])).toThrow(
      new TypeError('Durations must be finite numbers, received: -Infinity'),
    )
  })

  it('summarizes zero values without inventing a minimum', () => {
    expect(summarizeDurations([0, 0, 0])).toEqual({
      count: 3,
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      p99: 0,
    })
  })

  it('sorts an unsorted sample before taking min, max and percentiles', () => {
    const summary = summarizeDurations([100, 1, 50, 25])

    expect(summary.count).toBe(4)
    expect(summary.min).toBe(1)
    expect(summary.max).toBe(100)
    expect(summary.mean).toBe(44)
    expect(summary.p50).toBe(37.5)
    expect(summary.p95).toBeCloseTo(92.5, 10)
    expect(summary.p99).toBeCloseTo(98.5, 10)
  })

  it('keeps duplicated values distinct from their neighbours', () => {
    const summary = summarizeDurations([5, 5, 5, 9])

    expect(summary.min).toBe(5)
    expect(summary.max).toBe(9)
    expect(summary.p50).toBe(5)
    expect(summary.p95).toBeCloseTo(8.4, 10)
  })
})

describe('percentile', () => {
  it('accepts unsorted input', () => {
    expect(percentile([50, 10, 40, 20, 30], 0.5)).toBe(30)
  })

  it('returns exact endpoints at 0 and 1', () => {
    expect(percentile([3, 1, 2], 0)).toBe(1)
    expect(percentile([3, 1, 2], 1)).toBe(3)
  })

  it('rejects points outside [0, 1] and empty input', () => {
    expect(() => percentile([1, 2], -0.01)).toThrow(RangeError)
    expect(() => percentile([1, 2], 1.01)).toThrow(RangeError)
    expect(() => percentile([], 0.5)).toThrow(RangeError)
  })

  it('names the invalid point and the empty sample', () => {
    expect(() => percentile([1, 2], Number.NaN)).toThrow(
      new RangeError('Percentile point must be between 0 and 1: NaN'),
    )
    expect(() => percentile([1, 2], -0.5)).toThrow(
      new RangeError('Percentile point must be between 0 and 1: -0.5'),
    )
    expect(() => percentile([1, 2], 1.5)).toThrow(
      new RangeError('Percentile point must be between 0 and 1: 1.5'),
    )
    expect(() => percentile([], 0.5)).toThrow(
      new RangeError('Cannot compute a percentile of an empty sample'),
    )
  })

  it('does not reorder the caller array', () => {
    const sample = [50, 10, 40, 20, 30]

    expect(percentile(sample, 0.95)).toBeCloseTo(48, 10)
    expect(sample).toEqual([50, 10, 40, 20, 30])
  })
})

describe('quantileOfSorted', () => {
  it('matches the interpolated definition on a sorted sample', () => {
    const sorted = [1, 2, 3, 4]

    expect(quantileOfSorted(sorted, 0)).toBe(1)
    expect(quantileOfSorted(sorted, 0.5)).toBe(2.5)
    expect(quantileOfSorted(sorted, 1)).toBe(4)
  })

  it('rejects an invalid point', () => {
    expect(() => quantileOfSorted([1], Number.NaN)).toThrow(RangeError)
  })
})
