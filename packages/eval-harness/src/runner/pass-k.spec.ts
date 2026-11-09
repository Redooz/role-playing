import { describe, expect, it } from 'vitest'
import { binomial, computePassMetrics, type PassTrial } from './pass-k.js'

function trials(passed: readonly boolean[]): PassTrial[] {
  return passed.map((value, round) => ({
    round,
    taskId: 'task',
    lang: 'en',
    passed: value,
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
