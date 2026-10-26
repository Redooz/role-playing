/**
 * Small, dependency-free percentile maths for the latency harness.
 *
 * The harness reports p50/p95/p99 because the architecture plan's provisional
 * budgets (§2.4) are expressed as P99 values. At M0 these numbers are recorded
 * only; no budget is frozen until the first real measurement.
 */

/** Descriptive statistics for one workload's measured durations, in milliseconds. */
export interface PercentileSummary {
  readonly count: number
  readonly min: number
  readonly max: number
  readonly mean: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
}

/**
 * Quantile of an already sorted numeric array, using linear interpolation
 * between the two nearest ranks (the same definition as NumPy's default and
 * R's type 7). Works for any non-empty N, including N = 1.
 *
 * `point` is a fraction in [0, 1]: 0.95 means the 95th percentile.
 */
export function quantileOfSorted(sorted: readonly number[], point: number): number {
  if (!Number.isFinite(point) || point < 0 || point > 1) {
    throw new RangeError(`Percentile point must be between 0 and 1: ${point}`)
  }
  if (sorted.length === 0) {
    throw new RangeError('Cannot compute a percentile of an empty sample')
  }

  const rank = (sorted.length - 1) * point
  const lowerIndex = Math.floor(rank)
  const upperIndex = Math.ceil(rank)
  const lower = sorted[lowerIndex]
  const upper = sorted[upperIndex]

  if (lower === undefined || upper === undefined) {
    throw new RangeError(`Percentile index out of range for sample size ${sorted.length}`)
  }
  if (lowerIndex === upperIndex) return lower
  return lower + (upper - lower) * (rank - lowerIndex)
}

/**
 * Quantile of an unsorted sample. The input is copied before sorting, so the
 * caller's array is never mutated and repeated runs are stable.
 */
export function percentile(values: readonly number[], point: number): number {
  return quantileOfSorted(sortedFinite(values), point)
}

/**
 * Summarize a sample of durations (milliseconds) as min/max/mean/p50/p95/p99.
 *
 * Sorting once and computing every percentile from the sorted copy keeps this
 * cheap on large N and avoids relying on a statistics package.
 */
export function summarizeDurations(values: readonly number[]): PercentileSummary {
  const sorted = sortedFinite(values)
  if (sorted.length === 0) {
    throw new RangeError('Cannot summarize an empty sample')
  }

  const count = sorted.length
  let sum = 0
  for (const value of sorted) sum += value

  return {
    count,
    min: sorted[0] as number,
    max: sorted[count - 1] as number,
    mean: sum / count,
    p50: quantileOfSorted(sorted, 0.5),
    p95: quantileOfSorted(sorted, 0.95),
    p99: quantileOfSorted(sorted, 0.99),
  }
}

function sortedFinite(values: readonly number[]): number[] {
  const sorted = [...values]
  for (const value of sorted) {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Durations must be finite numbers, received: ${String(value)}`)
    }
  }
  return sorted.sort((a, b) => a - b)
}
