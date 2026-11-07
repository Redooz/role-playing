import { performance } from 'node:perf_hooks'
import type { GroqRequestTiming } from '@rp/pipeline'
import type { TextModelChunk, TextModelPort } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import { measureSessionLatency, summarizeLatency, type LatencyModel } from './session-latency.js'

function scriptedFactory(): LatencyModel {
  const timings: GroqRequestTiming[] = []
  const model: TextModelPort = {
    kind: 'canned',
    label: 'scripted',
    async *complete(_request, options) {
      const requestStartedAt = performance.now()
      if (options?.signal?.aborted === true) return
      yield { text: 'one ', done: false }
      yield { text: 'two', done: true }
      timings.push({
        requestStartedAt,
        firstContentAt: requestStartedAt + 0.5,
        finishedAt: performance.now(),
        ok: true,
        status: 200,
      })
    },
  }
  return { model, timings }
}

describe('text latency measurement', () => {
  it('collects per-turn and session-start samples and correlates provider time', async () => {
    const measurement = await measureSessionLatency({
      modelFactory: scriptedFactory,
      sessions: 2,
      turnsPerSession: 3,
      prompt: (sessionIndex, turnIndex) => `turn ${sessionIndex}:${turnIndex}`,
    })

    expect(measurement.failures).toHaveLength(0)
    expect(measurement.turns).toHaveLength(6)
    expect(measurement.sessionStarts).toHaveLength(2)

    for (const turn of measurement.turns) {
      expect(turn.ttftMs).toBeGreaterThanOrEqual(0)
      expect(turn.totalMs).toBeGreaterThanOrEqual(turn.ttftMs)
      expect(turn.providerTtftMs).toBeCloseTo(0.5)
      expect(turn.localOverheadMs).toBeCloseTo(turn.ttftMs - 0.5)
    }

    const summary = summarizeLatency(measurement)
    expect(summary.sessionStartToFirstChunkMs.count).toBe(2)
    expect(summary.turnTtftMs.count).toBe(6)
    expect(summary.turnTotalMs.count).toBe(6)
    expect(summary.providerTtftMs?.count).toBe(6)
    expect(summary.localOverheadMs?.count).toBe(6)
  })

  it('records a timeout as a failure instead of a sample', async () => {
    let timings: GroqRequestTiming[] = []
    const model: TextModelPort = {
      kind: 'canned',
      label: 'stalled',
      complete(_request, options): AsyncIterable<TextModelChunk> {
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<TextModelChunk>> {
                return new Promise((resolve) => {
                  const finish = (): void => resolve({ done: true, value: undefined })
                  if (options?.signal?.aborted === true) {
                    finish()
                    return
                  }
                  options?.signal?.addEventListener('abort', finish, { once: true })
                })
              },
            }
          },
        }
      },
    }

    const measurement = await measureSessionLatency({
      modelFactory: () => {
        timings = []
        return { model, timings }
      },
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      turnTimeoutMs: 20,
    })

    expect(measurement.turns).toHaveLength(0)
    expect(measurement.failures).toEqual([
      { sessionIndex: 0, turnIndex: 0, reason: 'timeout', message: 'interrupted' },
    ])
  })

  it('records a provider failure as a failure instead of a zero', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'failing',
      complete(): AsyncIterable<TextModelChunk> {
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<TextModelChunk>> {
                return Promise.reject(new Error('provider exploded'))
              },
            }
          },
        }
      },
    }

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model, timings: [] }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
    })

    expect(measurement.turns).toHaveLength(0)
    expect(measurement.failures).toHaveLength(1)
    expect(measurement.failures[0]?.reason).toBe('cancelled')
  })
})
