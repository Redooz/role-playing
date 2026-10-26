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
