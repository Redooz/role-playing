import { describe, expect, it } from 'vitest'

import { measureAsync, measureSync } from './measure.js'

describe('measureSync', () => {
  it('discards warmup iterations and reports the measured sample', () => {
    let tick = 0
    const calls: number[] = []

    const report = measureSync(
      'demo',
      3,
      () => {
        calls.push(calls.length)
      },
      { warmupIterations: 2, now: () => tick++ },
    )

    // 2 warmup + 3 measured runs; each measured span is one injected tick.
    expect(calls).toHaveLength(5)
    expect(report.workload).toBe('demo')
    expect(report.iterations).toBe(3)
    expect(report.warmupIterations).toBe(2)
    expect(report.durationsMs).toEqual([1, 1, 1])
    expect(report.totalMs).toBe(3)
    expect(report.percentiles).toEqual({
      count: 3,
      min: 1,
      max: 1,
      mean: 1,
      p50: 1,
      p95: 1,
      p99: 1,
    })
  })

  it('runs beforeEach before every iteration outside the measured span', () => {
    let tick = 0
    const prepared: number[] = []

    const report = measureSync('prepared', 2, () => undefined, {
      warmupIterations: 1,
      beforeEach: (iteration) => {
        prepared.push(iteration)
        tick += 1_000
      },
      now: () => tick,
    })

    expect(prepared).toEqual([0, 1, 2])
    expect(report.durationsMs).toEqual([0, 0])
  })

  it('defaults warmup to roughly ten percent of the iterations', () => {
    let runs = 0

    const report = measureSync('default-warmup', 10, () => {
      runs += 1
    })

    expect(runs).toBe(11)
    expect(report.warmupIterations).toBe(1)
    expect(report.iterations).toBe(10)
  })

  it('rejects invalid iteration counts', () => {
    expect(() => measureSync('bad', 0, () => undefined)).toThrow(RangeError)
    expect(() => measureSync('bad', 1.5, () => undefined)).toThrow(RangeError)
    expect(() => measureSync('bad', 1, () => undefined, { warmupIterations: -1 })).toThrow(
      RangeError,
    )
  })
})

describe('measureAsync', () => {
  it('times the full await and waits for async preparation', async () => {
    let tick = 0
    const steps: string[] = []

    const report = await measureAsync(
      'async-demo',
      2,
      async () => {
        steps.push('run')
        tick += 5
      },
      {
        warmupIterations: 1,
        beforeEach: async (iteration) => {
          await Promise.resolve()
          steps.push(`prepare-${iteration}`)
          tick += 1_000
        },
        now: () => tick,
      },
    )

    expect(steps).toEqual(['prepare-0', 'run', 'prepare-1', 'run', 'prepare-2', 'run'])
    expect(report.iterations).toBe(2)
    expect(report.durationsMs).toEqual([5, 5])
    expect(report.percentiles.p50).toBe(5)
  })

  it('rejects a zero iteration count', async () => {
    await expect(measureAsync('bad', 0, async () => undefined)).rejects.toThrow(RangeError)
  })
})
// draft additions for measure.spec.ts

describe('measureSync sample accounting', () => {
  it('reports the exact measured spans from an injected clock', () => {
    const ticks = [1_000, 1_005, 2_000, 2_007, 3_000, 3_002]

    const report = measureSync('exact', 2, () => undefined, {
      warmupIterations: 1,
      now: () => ticks.shift() as number,
    })

    expect(report).toStrictEqual({
      workload: 'exact',
      iterations: 2,
      warmupIterations: 1,
      totalMs: 9,
      durationsMs: [7, 2],
      percentiles: {
        count: 2,
        min: 2,
        max: 7,
        mean: 4.5,
        p50: 4.5,
        p95: 6.75,
        p99: 6.95,
      },
    })
  })

  it('floors the default warmup at ten percent of the iterations', () => {
    let runs = 0

    const report = measureSync('floor', 25, () => {
      runs += 1
    })

    expect(runs).toBe(27)
    expect(report.warmupIterations).toBe(2)
    expect(report.iterations).toBe(25)
  })

  it('does not warm up when ten percent floors to zero', () => {
    let runs = 0

    const report = measureSync('no-warmup', 5, () => {
      runs += 1
    })

    expect(runs).toBe(5)
    expect(report.warmupIterations).toBe(0)
    expect(report.durationsMs).toHaveLength(5)
  })

  it('accepts exactly one measured iteration', () => {
    const report = measureSync('single', 1, () => undefined, {
      warmupIterations: 0,
      now: () => 0,
    })

    expect(report.iterations).toBe(1)
    expect(report.durationsMs).toEqual([0])
  })

  it('accepts an explicit zero warmup', () => {
    let runs = 0

    const report = measureSync(
      'explicit-zero',
      3,
      () => {
        runs += 1
      },
      { warmupIterations: 0 },
    )

    expect(runs).toBe(3)
    expect(report.warmupIterations).toBe(0)
  })

  it.each([
    [0, 'Iterations must be a positive integer: 0'],
    [-1, 'Iterations must be a positive integer: -1'],
    [1.5, 'Iterations must be a positive integer: 1.5'],
    [Number.NaN, 'Iterations must be a positive integer: NaN'],
  ])('rejects iterations=%s with the exact message', (iterations, message) => {
    expect(() => measureSync('bad', iterations, () => undefined)).toThrow(new RangeError(message))
  })

  it.each([
    [-1, 'Warmup iterations must be a non-negative integer: -1'],
    [1.5, 'Warmup iterations must be a non-negative integer: 1.5'],
    [Number.NaN, 'Warmup iterations must be a non-negative integer: NaN'],
  ])('rejects warmupIterations=%s with the exact message', (warmupIterations, message) => {
    expect(() => measureSync('bad', 2, () => undefined, { warmupIterations })).toThrow(
      new RangeError(message),
    )
  })
})

describe('measureAsync sample accounting', () => {
  it('reports the exact measured spans from an injected clock', async () => {
    const ticks = [10, 15, 20, 22]

    const report = await measureAsync('async-exact', 2, async () => undefined, {
      warmupIterations: 0,
      now: () => ticks.shift() as number,
    })

    expect(report).toStrictEqual({
      workload: 'async-exact',
      iterations: 2,
      warmupIterations: 0,
      totalMs: 7,
      durationsMs: [5, 2],
      percentiles: {
        count: 2,
        min: 2,
        max: 5,
        mean: 3.5,
        p50: 3.5,
        p95: 4.85,
        p99: 4.97,
      },
    })
  })

  it('floors the default warmup and times the full await', async () => {
    const order: string[] = []

    const report = await measureAsync('async-default-warmup', 20, async () => {
      await Promise.resolve()
      order.push('run')
    })

    expect(report.warmupIterations).toBe(2)
    expect(report.iterations).toBe(20)
    expect(report.durationsMs).toHaveLength(20)
    expect(order).toHaveLength(22)
    expect(report.durationsMs.every((duration) => duration >= 0)).toBe(true)
  })

  it('accepts a synchronous run function and a missing beforeEach', async () => {
    let runs = 0

    const report = await measureAsync(
      'sync-run',
      2,
      () => {
        runs += 1
      },
      { warmupIterations: 0, now: () => 0 },
    )

    expect(runs).toBe(2)
    expect(report.durationsMs).toEqual([0, 0])
  })
})
