import { describe, expect, it } from 'vitest'
import { binomial, computePassMetrics, type PassTrial } from './pass-k.js'

function trials(passed: readonly boolean[], overrides: Partial<PassTrial> = {}): PassTrial[] {
  return passed.map((value, round) => ({
    round,
    taskId: 'task',
    lang: 'en',
    passed: value,
    ...overrides,
  }))
}

describe('pass^k', () => {
  it('computes the binomial coefficient', () => {
    expect(binomial(5, 3)).toBe(10)
    expect(binomial(3, 3)).toBe(1)
    expect(binomial(2, 3)).toBe(0)
  })

  it('reports pass^1 and pass^3 together', () => {
    const metrics = computePassMetrics(trials([true, true, true, false, false]), 3)
    expect(metrics.pass1).toBeCloseTo(0.6)
    expect(metrics.passK).toBeCloseTo(1 / 10)
    expect(metrics.tasks[0]?.successes).toBe(3)
  })

  it('averages per task, not per trial', () => {
    const metrics = computePassMetrics(
      [
        ...trials([true, true, true]),
        ...trials([true, true, true]).map((trial) => ({ ...trial, taskId: 'task-2' })),
        ...trials([false, false, false]).map((trial) => ({ ...trial, taskId: 'task-3' })),
      ],
      3,
    )
    expect(metrics.pass1).toBeCloseTo(2 / 3)
    expect(metrics.passK).toBeCloseTo(2 / 3)
  })

  it('omits pass^k when no task has k trials', () => {
    const metrics = computePassMetrics(trials([true, true]), 3)
    expect(metrics.pass1).toBe(1)
    expect(metrics.passK).toBeUndefined()
  })

  it('rejects an invalid k', () => {
    expect(() => computePassMetrics([], 0)).toThrow(TypeError)
  })
})

describe('binomial coefficient', () => {
  it.each([
    { n: 0, k: 0, expected: 1 },
    { n: 5, k: 0, expected: 1 },
    { n: 5, k: 5, expected: 1 },
    { n: 5, k: 1, expected: 5 },
    { n: 5, k: 3, expected: 10 },
    { n: 6, k: 2, expected: 15 },
    { n: 10, k: 4, expected: 210 },
  ])('returns $expected for C($n, $k)', ({ n, k, expected }) => {
    expect(binomial(n, k)).toBe(expected)
  })

  it.each([
    { n: 2.5, k: 1, label: 'a fractional n' },
    { n: 5, k: 1.5, label: 'a fractional k' },
    { n: -1, k: 0, label: 'a negative n' },
    { n: 5, k: -1, label: 'a negative k' },
    { n: 2, k: 3, label: 'k greater than n' },
    { n: Number.NaN, k: 1, label: 'NaN n' },
    { n: 5, k: Number.POSITIVE_INFINITY, label: 'infinite k' },
  ])('returns 0 for $label', ({ n, k }) => {
    expect(binomial(n, k)).toBe(0)
  })
})

describe('computePassMetrics exact readings', () => {
  it('returns an empty, pass^k-free reading when there are no trials', () => {
    expect(computePassMetrics([], 3)).toStrictEqual({
      k: 3,
      pass1: 0,
      tasks: [],
    })
  })

  it('defaults k to 3', () => {
    expect(computePassMetrics(trials([true, true, true]))).toStrictEqual({
      k: 3,
      pass1: 1,
      passK: 1,
      tasks: [{ lang: 'en', taskId: 'task', trials: 3, successes: 3, pass1: 1, passK: 1 }],
    })
  })

  it('treats k = 1 as the per-task success rate', () => {
    expect(computePassMetrics(trials([true, false]), 1)).toStrictEqual({
      k: 1,
      pass1: 0.5,
      passK: 0.5,
      tasks: [{ lang: 'en', taskId: 'task', trials: 2, successes: 1, pass1: 0.5, passK: 0.5 }],
    })
  })

  it('computes C(c, k) / C(n, k) for k = 2', () => {
    expect(computePassMetrics(trials([true, true, false]), 2)).toStrictEqual({
      k: 2,
      pass1: 2 / 3,
      passK: 1 / 3,
      tasks: [{ lang: 'en', taskId: 'task', trials: 3, successes: 2, pass1: 2 / 3, passK: 1 / 3 }],
    })
  })

  it('reports pass^k = 0 when fewer than k trials succeeded', () => {
    expect(computePassMetrics(trials([true, true, false, false, false]), 3)).toStrictEqual({
      k: 3,
      pass1: 2 / 5,
      passK: 0,
      tasks: [{ lang: 'en', taskId: 'task', trials: 5, successes: 2, pass1: 2 / 5, passK: 0 }],
    })
  })

  it('reports pass^k when a task has exactly k trials', () => {
    const metrics = computePassMetrics(trials([true, true, true]), 3)
    expect(metrics.tasks[0]?.passK).toBe(1)
  })

  it('orders tasks by language then task id, independent of input order', () => {
    const metrics = computePassMetrics(
      [
        ...trials([true], { lang: 'fr', taskId: 'task-b' }),
        ...trials([true], { lang: 'en', taskId: 'task-b' }),
        ...trials([true], { lang: 'fr', taskId: 'task-a' }),
        ...trials([true], { lang: 'en', taskId: 'task-a' }),
      ],
      1,
    )

    expect(metrics.tasks).toStrictEqual([
      { lang: 'en', taskId: 'task-a', trials: 1, successes: 1, pass1: 1, passK: 1 },
      { lang: 'en', taskId: 'task-b', trials: 1, successes: 1, pass1: 1, passK: 1 },
      { lang: 'fr', taskId: 'task-a', trials: 1, successes: 1, pass1: 1, passK: 1 },
      { lang: 'fr', taskId: 'task-b', trials: 1, successes: 1, pass1: 1, passK: 1 },
    ])
  })

  it('keeps same-id tasks in different languages apart', () => {
    const metrics = computePassMetrics(
      [...trials([true, false], { lang: 'en' }), ...trials([true, true], { lang: 'fr' })],
      2,
    )

    expect(metrics.tasks).toStrictEqual([
      { lang: 'en', taskId: 'task', trials: 2, successes: 1, pass1: 0.5, passK: 0 },
      { lang: 'fr', taskId: 'task', trials: 2, successes: 2, pass1: 1, passK: 1 },
    ])
  })

  it('averages pass^k only over tasks that reach k trials', () => {
    const metrics = computePassMetrics(
      [
        ...trials([true, true, true, false, false]),
        ...trials([true, true, true]).map((trial) => ({ ...trial, taskId: 'task-b' })),
        ...trials([true, true]).map((trial) => ({ ...trial, taskId: 'task-c' })),
      ],
      3,
    )

    expect(metrics.pass1).toBe((3 / 5 + 1 + 1) / 3)
    expect(metrics.passK).toBe((1 / 10 + 1) / 2)
    expect(metrics.tasks).toStrictEqual([
      { lang: 'en', taskId: 'task', trials: 5, successes: 3, pass1: 3 / 5, passK: 1 / 10 },
      { lang: 'en', taskId: 'task-b', trials: 3, successes: 3, pass1: 1, passK: 1 },
      { lang: 'en', taskId: 'task-c', trials: 2, successes: 2, pass1: 1 },
    ])
  })

  it.each([
    { k: 0, label: 'zero' },
    { k: -1, label: 'a negative integer' },
    { k: 1.5, label: 'a fraction' },
    { k: Number.NaN, label: 'NaN' },
    { k: Number.POSITIVE_INFINITY, label: 'infinity' },
  ])('throws an exact TypeError for k = $label', ({ k }) => {
    expect(() => computePassMetrics([], k)).toThrow(
      new TypeError(`k must be a positive integer: ${k}`),
    )
  })
})
