import { performance } from 'node:perf_hooks'

import { summarizeDurations, type PercentileSummary } from './percentiles.js'

/**
 * Wall-clock measurement core for the latency harness.
 *
 * Wall-clock timing (`performance.now()`) is legitimate here: this is a
 * benchmark, not engine code. The simulated-time rule in the architecture plan
 * (§2.3) applies to the session engine and eval replay, not to measuring real
 * hardware cost. At M0 the harness only records harness overhead (fake-clock
 * dispatch, event serialization, trace append); **no latency budget is frozen
 * at M0**. Budgets freeze only once real measurements exist (§2.4).
 */

/** Result of measuring one workload. Durations are milliseconds. */
export interface MeasurementReport {
  readonly workload: string
  readonly iterations: number
  readonly warmupIterations: number
  /** Sum of the measured durations, excluding warmup. */
  readonly totalMs: number
  readonly durationsMs: readonly number[]
  readonly percentiles: PercentileSummary
}

interface BaseMeasureOptions {
  /** Iterations to run and discard before measuring. Defaults to 10% of N. */
  readonly warmupIterations?: number
  /** Wall-clock source. Defaults to `performance.now`; injectable for unit tests. */
  readonly now?: () => number
}

export interface SyncMeasureOptions extends BaseMeasureOptions {
  /**
   * Runs before every warmup and measured iteration, outside the timed section.
   * Use it to rebuild inputs that a run consumes (for example a fresh fake clock).
   */
  readonly beforeEach?: (iteration: number) => void
}

export interface AsyncMeasureOptions extends BaseMeasureOptions {
  /** Async variant of `beforeEach`; awaited before the timed section. */
  readonly beforeEach?: (iteration: number) => void | Promise<void>
}

/**
 * Run a synchronous workload `iterations` times, discard a warmup phase, and
 * summarize the measured wall durations.
 */
export function measureSync(
  workload: string,
  iterations: number,
  run: () => void,
  options: SyncMeasureOptions = {},
): MeasurementReport {
  const warmupIterations = resolveWarmup(iterations, options.warmupIterations)
  const now = options.now ?? (() => performance.now())
  const durationsMs: number[] = []

  for (let iteration = 0; iteration < warmupIterations + iterations; iteration += 1) {
    options.beforeEach?.(iteration)
    const startedAt = now()
    run()
    const elapsed = now() - startedAt
    if (iteration >= warmupIterations) durationsMs.push(elapsed)
  }

  return buildReport(workload, warmupIterations, durationsMs)
}

/**
 * Run an asynchronous workload `iterations` times, discard a warmup phase, and
 * summarize the measured wall durations. Async workloads (such as fake-clock
 * dispatch) are timed across their full `await`.
 */
export async function measureAsync(
  workload: string,
  iterations: number,
  run: () => void | Promise<void>,
  options: AsyncMeasureOptions = {},
): Promise<MeasurementReport> {
  const warmupIterations = resolveWarmup(iterations, options.warmupIterations)
  const now = options.now ?? (() => performance.now())
  const durationsMs: number[] = []

  for (let iteration = 0; iteration < warmupIterations + iterations; iteration += 1) {
    await options.beforeEach?.(iteration)
    const startedAt = now()
    await run()
    const elapsed = now() - startedAt
    if (iteration >= warmupIterations) durationsMs.push(elapsed)
  }

  return buildReport(workload, warmupIterations, durationsMs)
}

function resolveWarmup(iterations: number, warmupIterations: number | undefined): number {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new RangeError(`Iterations must be a positive integer: ${iterations}`)
  }

  const warmup = warmupIterations === undefined ? Math.floor(iterations / 10) : warmupIterations
  if (!Number.isInteger(warmup) || warmup < 0) {
    throw new RangeError(`Warmup iterations must be a non-negative integer: ${warmup}`)
  }
  return warmup
}

function buildReport(
  workload: string,
  warmupIterations: number,
  durationsMs: readonly number[],
): MeasurementReport {
  let totalMs = 0
  for (const duration of durationsMs) totalMs += duration

  return {
    workload,
    iterations: durationsMs.length,
    warmupIterations,
    totalMs,
    durationsMs,
    percentiles: summarizeDurations(durationsMs),
  }
}
