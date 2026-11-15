import { performance } from 'node:perf_hooks'
import type { GroqRequestTiming } from '@rp/pipeline'
import type * as SessionCoreModule from '@rp/session-core'
import type { SessionDriver, SessionEvent, TextModelChunk, TextModelPort } from '@rp/session-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  measureSessionLatency,
  summarizeLatency,
  type LatencyMeasurement,
  type LatencyModel,
} from './session-latency.js'

function scriptedFactory(): LatencyModel {
  const timings: GroqRequestTiming[] = []
  const model: TextModelPort = {
    kind: 'canned',
    label: 'scripted',
    async *complete(request, options) {
      const requestStartedAt = performance.now()
      const requestId = request.requestId
      if (options?.signal?.aborted === true) return
      yield { text: 'one ', done: false }
      yield { text: 'two', done: true }
      timings.push({
        ...(requestId === undefined ? {} : { requestId }),
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
      // Independently injectable clocks can disagree; the bench clamps at 0.
      expect(turn.localOverheadMs).toBeCloseTo(Math.max(0, turn.ttftMs - 0.5))
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
    expect(measurement.failures[0]?.reason).toBe('provider_failure')
  })

  it('records a timeout when the provider ignores the abort signal', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'ignores-abort',
      complete() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<TextModelChunk>> {
                return new Promise(() => undefined)
              },
            }
          },
        }
      },
    }
    const startedAt = Date.now()

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model, timings: [] }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      turnTimeoutMs: 20,
    })

    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(measurement.turns).toHaveLength(0)
    expect(measurement.failures).toHaveLength(1)
    expect(measurement.failures[0]?.reason).toBe('timeout')
    expect(measurement.failures[0]?.message).toBe('interrupted')
  })

  it('attributes a late timing by request id instead of list position', async () => {
    const timings: GroqRequestTiming[] = []
    let call = 0

    const model: TextModelPort = {
      kind: 'canned',
      label: 'late-timing',
      complete(request) {
        call += 1
        const requestId = request.requestId
        const id = requestId === undefined ? {} : { requestId }

        if (call === 1) {
          return {
            [Symbol.asyncIterator]() {
              return {
                next(): Promise<IteratorResult<TextModelChunk>> {
                  return new Promise(() => undefined)
                },
                return(): Promise<IteratorResult<TextModelChunk>> {
                  // The abandoned request reports after the next turn starts.
                  setTimeout(() => {
                    timings.push({
                      ...id,
                      requestStartedAt: 0,
                      firstContentAt: 0,
                      finishedAt: 0,
                      ok: false,
                    })
                  }, 1)
                  return Promise.resolve({ done: true, value: undefined })
                },
              }
            },
          }
        }

        return (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 10))
          yield { text: 'ok', done: true }
          timings.push({
            ...id,
            requestStartedAt: 0,
            firstContentAt: 0.5,
            finishedAt: 1,
            ok: true,
          })
        })()
      },
    }

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model, timings }),
      sessions: 1,
      turnsPerSession: 2,
      prompt: () => 'go',
      turnTimeoutMs: 30,
    })

    expect(measurement.failures).toHaveLength(1)
    expect(measurement.failures[0]?.turnIndex).toBe(0)
    expect(measurement.turns).toHaveLength(1)
    expect(measurement.turns[0]?.turnIndex).toBe(1)
    expect(measurement.turns[0]?.providerTtftMs).toBeCloseTo(0.5)
  })
})
// draft additions for session-latency.spec.ts

const driverState = vi.hoisted(() => ({
  factory: undefined as undefined | ((options: unknown) => unknown),
  options: [] as unknown[],
}))

vi.mock('@rp/session-core', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionCoreModule>()
  return {
    ...actual,
    createTextSessionDriver: (
      options: Parameters<typeof actual.createTextSessionDriver>[0],
    ): ReturnType<typeof actual.createTextSessionDriver> => {
      driverState.options.push(options)
      const factory = driverState.factory
      return factory === undefined
        ? actual.createTextSessionDriver(options)
        : (factory(options) as ReturnType<typeof actual.createTextSessionDriver>)
    },
  }
})

type IteratorResultOfEvent = IteratorResult<SessionEvent>

class FakeDriver implements SessionDriver {
  readonly sessionId = 'fake-session'
  readonly sent: string[] = []
  interruptCalls = 0
  readonly #script: FakeDriverScript
  #queue: SessionEvent[] = []
  #waiters: Array<(result: IteratorResultOfEvent) => void> = []
  #ended = false

  constructor(script: FakeDriverScript) {
    this.#script = script
  }

  readonly events: AsyncIterable<SessionEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResultOfEvent> => {
        const event = this.#queue.shift()
        if (event !== undefined) return Promise.resolve({ done: false, value: event })
        if (this.#ended) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
      return: (): Promise<IteratorResultOfEvent> => {
        this.end()
        return Promise.resolve({ done: true, value: undefined })
      },
    }),
  }

  push(event: SessionEvent): void {
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      waiter({ done: false, value: event })
      return
    }
    this.#queue.push(event)
  }

  end(): void {
    this.#ended = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined })
    }
  }

  async start(): Promise<void> {}

  async send(text: string): Promise<void> {
    this.sent.push(text)
    await this.#script.onSend?.(text, this.sent.length, this)
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1
    await this.#script.onInterrupt?.(this)
  }

  async close(): Promise<void> {
    await this.#script.onClose?.(this)
    this.end()
  }
}

interface FakeDriverScript {
  readonly onSend?: (text: string, call: number, driver: FakeDriver) => void | Promise<void>
  readonly onInterrupt?: (driver: FakeDriver) => void | Promise<void>
  readonly onClose?: (driver: FakeDriver) => void | Promise<void>
}

function fakeModel(dispose?: () => void | Promise<void>): TextModelPort {
  return {
    kind: 'canned',
    label: 'fake',
    complete: () => (async function* () {})(),
    ...(dispose === undefined ? {} : { dispose }),
  }
}

function useFakeDriver(driver: FakeDriver): void {
  driverState.factory = () => driver
}

function scriptedClock(...values: number[]): () => number {
  const queue = [...values]
  return () => {
    const next = queue.shift()
    if (next === undefined) throw new Error('scripted clock ran out of values')
    return next
  }
}

function granted(turnId: string): SessionEvent {
  return {
    type: 'turn.granted',
    payload: {
      grant: {
        turnId,
        grantId: `grant-${turnId}`,
        personaId: 'persona-1',
        expiresAt: '2026-11-14T00:00:00.000Z',
      },
    },
  } as SessionEvent
}

function chunk(text = 'hi'): SessionEvent {
  return {
    type: 'persona.response.chunk',
    payload: { grantId: 'grant-1', text, sequence: 0 },
  } as SessionEvent
}

function committed(text = 'hi'): SessionEvent {
  return {
    type: 'persona.response.committed',
    payload: { grantId: 'grant-1', text },
  } as SessionEvent
}

function cancelled(reason: string): SessionEvent {
  return {
    type: 'persona.response.cancelled',
    payload: { grantId: 'grant-1', reason },
  } as SessionEvent
}

function emptyMeasurement(): LatencyMeasurement {
  return { turns: [], sessionStarts: [], failures: [] }
}

function timing(overrides: Partial<GroqRequestTiming>): GroqRequestTiming {
  return { requestStartedAt: 0, finishedAt: 0, ok: true, ...overrides }
}

afterEach(() => {
  driverState.factory = undefined
  driverState.options = []
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('text latency measurement with a scripted driver', () => {
  it('records the exact per-turn samples and session start', async () => {
    const timings: GroqRequestTiming[] = [
      timing({ requestId: 'turn-0', requestStartedAt: 50, firstContentAt: 60, finishedAt: 130 }),
      timing({ requestId: 'turn-1', requestStartedAt: 0, firstContentAt: 50, finishedAt: 240 }),
    ]
    const driver = new FakeDriver({
      onSend: (_text, call, target) => {
        target.push(granted(`turn-${call - 1}`))
        target.push(chunk())
        target.push(committed())
      },
    })
    useFakeDriver(driver)
    const prompts: string[] = []

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings }),
      sessions: 1,
      turnsPerSession: 2,
      prompt: (sessionIndex, turnIndex) => {
        const prompt = `${sessionIndex}:${turnIndex}`
        prompts.push(prompt)
        return prompt
      },
      now: scriptedClock(0, 100, 110, 115, 130, 200, 205, 209, 240),
    })

    expect(prompts).toEqual(['0:0', '0:1'])
    expect(driver.sent).toEqual(['0:0', '0:1'])
    expect(driver.interruptCalls).toBe(0)
    expect(measurement).toStrictEqual({
      turns: [
        {
          sessionIndex: 0,
          turnIndex: 0,
          ttftMs: 15,
          totalMs: 30,
          providerTtftMs: 10,
          localOverheadMs: 5,
        },
        {
          sessionIndex: 0,
          turnIndex: 1,
          ttftMs: 9,
          totalMs: 40,
          providerTtftMs: 50,
          localOverheadMs: 0,
        },
      ],
      sessionStarts: [{ sessionIndex: 0, ms: 115 }],
      failures: [],
    })
  })

  it('builds a wall-clock English driver with one session id per index', async () => {
    const drivers = [
      new FakeDriver({
        onSend: (_text, _call, target) => {
          target.push(granted('turn-0'))
          target.push(chunk())
          target.push(committed())
        },
      }),
      new FakeDriver({
        onSend: (_text, _call, target) => {
          target.push(granted('turn-0'))
          target.push(chunk())
          target.push(committed())
        },
      }),
    ]
    const queue = [...drivers]
    driverState.factory = () => queue.shift() as FakeDriver

    await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [] }),
      sessions: 2,
      turnsPerSession: 1,
      prompt: () => 'go',
      now: scriptedClock(0, 1, 2, 3, 4, 10, 11, 12, 13, 14),
    })

    expect(driverState.options).toHaveLength(2)
    const sessions = driverState.options as Array<{
      sessionId: string
      lang: string
      clockMode: string
    }>
    expect(sessions[0]?.sessionId).toBe('latency-0')
    expect(sessions[1]?.sessionId).toBe('latency-1')
    expect(sessions[0]?.lang).toBe('en')
    expect(sessions[1]?.lang).toBe('en')
    expect(sessions[0]?.clockMode).toBe('wall')
    expect(sessions[1]?.clockMode).toBe('wall')
  })

  it('clears the turn boundary timers once a turn settles', async () => {
    const driver = new FakeDriver({
      onSend: (_text, _call, target) => {
        target.push(granted('turn-0'))
        target.push(chunk())
        target.push(committed())
      },
    })
    useFakeDriver(driver)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [] }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      now: scriptedClock(0, 10, 20, 30, 40),
    })

    expect(measurement.turns).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the first chunk for ttft and the first session chunk for the start sample', async () => {
    const driver = new FakeDriver({
      onSend: (_text, _call, target) => {
        target.push(granted('turn-0'))
        target.push(chunk('one '))
        target.push(chunk('two'))
        target.push(committed('one two'))
      },
    })
    useFakeDriver(driver)

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [] }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      now: scriptedClock(0, 5, 10, 20, 30, 40),
    })

    expect(measurement.turns).toStrictEqual([
      { sessionIndex: 0, turnIndex: 0, ttftMs: 15, totalMs: 35 },
    ])
    expect(measurement.sessionStarts).toStrictEqual([{ sessionIndex: 0, ms: 20 }])
  })

  it('mints one fresh driver and model per session and stamps the session index', async () => {
    const drivers = [
      new FakeDriver({
        onSend: (_text, _call, target) => {
          target.push(granted('turn-0'))
          target.push(chunk())
          target.push(committed())
        },
      }),
      new FakeDriver({
        onSend: (_text, _call, target) => {
          target.push(granted('turn-0'))
          target.push(chunk())
          target.push(committed())
        },
      }),
    ]
    const queue = [...drivers]
    driverState.factory = () => queue.shift() as FakeDriver
    const disposals: Array<() => void | Promise<void>> = []

    const measurement = await measureSessionLatency({
      modelFactory: () => {
        const dispose = (): void => undefined
        disposals.push(dispose)
        return { model: fakeModel(dispose), timings: [] }
      },
      sessions: 2,
      turnsPerSession: 1,
      prompt: () => 'go',
      now: scriptedClock(0, 10, 20, 25, 30, 100, 110, 120, 124, 140),
    })

    expect(measurement.turns).toStrictEqual([
      { sessionIndex: 0, turnIndex: 0, ttftMs: 15, totalMs: 20 },
      { sessionIndex: 1, turnIndex: 0, ttftMs: 14, totalMs: 30 },
    ])
    expect(measurement.sessionStarts).toStrictEqual([
      { sessionIndex: 0, ms: 25 },
      { sessionIndex: 1, ms: 24 },
    ])
    expect(disposals).toHaveLength(2)
    expect(queue).toHaveLength(0)
  })

  it('paces sessions, but not the first one, when a throttle is set', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const queues = [
      new FakeDriver({
        onSend: (_text, _call, target) => {
          target.push(granted('turn-0'))
          target.push(chunk())
          target.push(committed())
        },
      }),
      new FakeDriver({
        onSend: (_text, _call, target) => {
          target.push(granted('turn-0'))
          target.push(chunk())
          target.push(committed())
        },
      }),
    ]
    driverState.factory = () => queues.shift() as FakeDriver

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [] }),
      sessions: 2,
      turnsPerSession: 1,
      prompt: () => 'go',
      throttleMs: 7,
      now: scriptedClock(0, 1, 2, 3, 4, 10, 11, 12, 13, 14),
    })

    expect(measurement.turns).toHaveLength(2)
    const throttleDelays = timeoutSpy.mock.calls.filter((call) => call[1] === 7)
    expect(throttleDelays).toHaveLength(1)
  })

  it('paces turns within a session when a throttle is set', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const driver = new FakeDriver({
      onSend: (_text, _call, target) => {
        target.push(granted('turn-0'))
        target.push(chunk())
        target.push(committed())
      },
    })
    useFakeDriver(driver)

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [] }),
      sessions: 1,
      turnsPerSession: 2,
      prompt: () => 'go',
      throttleMs: 7,
      now: scriptedClock(0, 1, 2, 3, 4, 10, 11, 12, 13, 14),
    })

    expect(measurement.turns).toHaveLength(2)
    const throttleDelays = timeoutSpy.mock.calls.filter((call) => call[1] === 7)
    expect(throttleDelays).toHaveLength(1)
  })

  it('does not pace when the throttle is zero', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const queues = [
      new FakeDriver({
        onSend: (_text, _call, target) => {
          target.push(chunk())
          target.push(committed())
        },
      }),
      new FakeDriver({
        onSend: (_text, _call, target) => {
          target.push(chunk())
          target.push(committed())
        },
      }),
    ]
    driverState.factory = () => queues.shift() as FakeDriver

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [] }),
      sessions: 2,
      turnsPerSession: 2,
      prompt: () => 'go',
      throttleMs: 0,
      now: scriptedClock(0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 16),
    })

    expect(measurement.turns).toHaveLength(4)
    expect(timeoutSpy.mock.calls.filter((call) => call[1] === 0)).toHaveLength(0)
  })

  it('records a commit without a chunk as an empty failure', async () => {
    const driver = new FakeDriver({
      onSend: (_text, _call, target) => {
        target.push(granted('turn-0'))
        target.push(committed())
      },
    })
    useFakeDriver(driver)

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [] }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      now: scriptedClock(0, 10, 12, 15),
    })

    expect(measurement).toStrictEqual({
      turns: [],
      sessionStarts: [],
      failures: [
        {
          sessionIndex: 0,
          turnIndex: 0,
          reason: 'empty',
          message: 'response committed without a text chunk',
        },
      ],
    })
  })

  it.each([
    ['interrupted', 'cancelled', 'interrupted'],
    ['user_barge_in', 'cancelled', 'user_barge_in'],
    ['provider_failure', 'provider_failure', 'provider_failure'],
    ['timeout', 'timeout', 'timeout'],
  ] as const)(
    'maps cancellation reason %s to %s with the reason as the message',
    async (cancellationReason, failureReason, message) => {
      const driver = new FakeDriver({
        onSend: (_text, _call, target) => {
          target.push(granted('turn-0'))
          target.push(cancelled(cancellationReason))
        },
      })
      useFakeDriver(driver)

      const measurement = await measureSessionLatency({
        modelFactory: () => ({ model: fakeModel(), timings: [] }),
        sessions: 1,
        turnsPerSession: 1,
        prompt: () => 'go',
        now: scriptedClock(0, 10, 12, 15),
      })

      expect(measurement.failures).toStrictEqual([
        { sessionIndex: 0, turnIndex: 0, reason: failureReason, message },
      ])
      expect(measurement.turns).toStrictEqual([])
    },
  )

  it('ignores a second commit once the turn is already recorded', async () => {
    const driver = new FakeDriver({
      onSend: (_text, _call, target) => {
        target.push(granted('turn-0'))
        target.push(chunk())
        target.push(committed())
        target.push(committed())
      },
    })
    useFakeDriver(driver)

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [] }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      now: scriptedClock(0, 10, 12, 15, 20, 25),
    })

    expect(measurement.turns).toStrictEqual([
      { sessionIndex: 0, turnIndex: 0, ttftMs: 5, totalMs: 10 },
    ])
    expect(measurement.failures).toStrictEqual([])
  })

  it('records an empty commit then counts a later chunk as the session start', async () => {
    const driver = new FakeDriver({
      onSend: (_text, _call, target) => {
        target.push(granted('turn-0'))
        target.push(committed())
        target.push(chunk())
        target.push(committed())
      },
    })
    useFakeDriver(driver)

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [] }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      now: scriptedClock(0, 10, 12, 15, 20, 25),
    })

    expect(measurement.turns).toStrictEqual([])
    expect(measurement.sessionStarts).toStrictEqual([{ sessionIndex: 0, ms: 20 }])
    expect(measurement.failures).toStrictEqual([
      {
        sessionIndex: 0,
        turnIndex: 0,
        reason: 'empty',
        message: 'response committed without a text chunk',
      },
    ])
  })

  it('omits provider timing when the turn carries no grant', async () => {
    const driver = new FakeDriver({
      onSend: (_text, _call, target) => {
        target.push(chunk())
        target.push(committed())
      },
    })
    useFakeDriver(driver)
    const timings = [timing({ requestStartedAt: 0, firstContentAt: 5, finishedAt: 1 })]

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      now: scriptedClock(0, 10, 20, 30),
    })

    expect(measurement.turns).toStrictEqual([
      { sessionIndex: 0, turnIndex: 0, ttftMs: 10, totalMs: 20 },
    ])
  })

  it('omits provider timing when the matching entry has no first content', async () => {
    const driver = new FakeDriver({
      onSend: (_text, _call, target) => {
        target.push(granted('turn-0'))
        target.push(chunk())
        target.push(committed())
      },
    })
    useFakeDriver(driver)
    const timings = [timing({ requestId: 'turn-0', requestStartedAt: 0, finishedAt: 1 })]

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      now: scriptedClock(0, 10, 20, 30, 40),
    })

    expect(measurement.turns).toStrictEqual([
      { sessionIndex: 0, turnIndex: 0, ttftMs: 20, totalMs: 30 },
    ])
  })

  it('matches timings by request id, not by list position', async () => {
    const driver = new FakeDriver({
      onSend: (_text, _call, target) => {
        target.push(granted('turn-0'))
        target.push(chunk())
        target.push(committed())
      },
    })
    useFakeDriver(driver)
    const timings = [
      timing({ requestId: 'other', requestStartedAt: 0, firstContentAt: 99, finishedAt: 1 }),
    ]

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      now: scriptedClock(0, 10, 20, 30, 40),
    })

    expect(measurement.turns).toStrictEqual([
      { sessionIndex: 0, turnIndex: 0, ttftMs: 20, totalMs: 30 },
    ])
  })

  it('does not let a previous turn request id attribute the next turn', async () => {
    const driver = new FakeDriver({
      onSend: (_text, call, target) => {
        if (call === 1) target.push(granted('turn-0'))
        target.push(chunk())
        target.push(committed())
      },
    })
    useFakeDriver(driver)
    const timings = [
      timing({ requestId: 'turn-0', requestStartedAt: 0, firstContentAt: 10, finishedAt: 1 }),
    ]

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings }),
      sessions: 1,
      turnsPerSession: 2,
      prompt: () => 'go',
      now: scriptedClock(0, 10, 12, 15, 20, 30, 32, 40),
    })

    expect(measurement.turns).toStrictEqual([
      {
        sessionIndex: 0,
        turnIndex: 0,
        ttftMs: 5,
        totalMs: 10,
        providerTtftMs: 10,
        localOverheadMs: 0,
      },
      { sessionIndex: 0, turnIndex: 1, ttftMs: 2, totalMs: 10 },
    ])
  })

  it.each([
    [new Error('send failed'), 'send failed'],
    ['plain failure', 'plain failure'],
    [42, '42'],
  ] as const)('records a rejected send as an error failure', async (error, message) => {
    const driver = new FakeDriver({
      onSend: () => {
        throw error
      },
    })
    useFakeDriver(driver)

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [] }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      now: scriptedClock(0, 10),
    })

    expect(measurement.failures).toStrictEqual([
      { sessionIndex: 0, turnIndex: 0, reason: 'error', message },
    ])
  })

  it('prefers the model error captured during the turn', async () => {
    const errors: unknown[] = []
    const driver = new FakeDriver({
      onSend: () => {
        errors.push(new Error('provider exploded'))
        throw new Error('send failed')
      },
    })
    useFakeDriver(driver)

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [], errors }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      now: scriptedClock(0, 10),
    })

    expect(measurement.failures).toStrictEqual([
      { sessionIndex: 0, turnIndex: 0, reason: 'error', message: 'provider exploded' },
    ])
  })

  it('stringifies a captured non-Error model failure', async () => {
    const errors: unknown[] = []
    const driver = new FakeDriver({
      onSend: () => {
        errors.push('canned failure')
        throw new Error('send failed')
      },
    })
    useFakeDriver(driver)

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [], errors }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      now: scriptedClock(0, 10),
    })

    expect(measurement.failures).toStrictEqual([
      { sessionIndex: 0, turnIndex: 0, reason: 'error', message: 'canned failure' },
    ])
  })

  it('ignores a model error captured before the failing turn', async () => {
    const driver = new FakeDriver({
      onSend: () => {
        throw new Error('send failed')
      },
    })
    useFakeDriver(driver)

    const measurement = await measureSessionLatency({
      modelFactory: () => ({
        model: fakeModel(),
        timings: [],
        errors: [new Error('earlier turn')],
      }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      now: scriptedClock(0, 10),
    })

    expect(measurement.failures).toStrictEqual([
      { sessionIndex: 0, turnIndex: 0, reason: 'error', message: 'send failed' },
    ])
  })

  it('records a turn that resolves send without a terminal event as a timeout', async () => {
    const driver = new FakeDriver({})
    useFakeDriver(driver)
    const startedAt = Date.now()

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [] }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      turnTimeoutMs: 15,
      now: scriptedClock(0, 10),
    })

    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(measurement.failures).toStrictEqual([
      {
        sessionIndex: 0,
        turnIndex: 0,
        reason: 'timeout',
        message: 'driver did not emit a terminal event within the 15 ms turn timeout',
      },
    ])
  })

  it('waits for a terminal event even when the interrupt stops the send', async () => {
    let releaseSend: (() => void) | undefined
    const driver = new FakeDriver({
      onSend: () =>
        new Promise<void>((resolve) => {
          releaseSend = resolve
        }),
      onInterrupt: () => {
        releaseSend?.()
      },
    })
    useFakeDriver(driver)
    const startedAt = Date.now()

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [] }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      turnTimeoutMs: 15,
      now: scriptedClock(0, 10),
    })

    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(driver.interruptCalls).toBe(1)
    expect(measurement.failures).toStrictEqual([
      {
        sessionIndex: 0,
        turnIndex: 0,
        reason: 'timeout',
        message: 'driver did not emit a terminal event within the 15 ms turn timeout',
      },
    ])
  })

  it('records a send that ignores the interrupt as a timeout', async () => {
    const driver = new FakeDriver({
      onSend: () => new Promise<void>(() => undefined),
    })
    useFakeDriver(driver)
    const startedAt = Date.now()

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [] }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      turnTimeoutMs: 15,
      now: scriptedClock(0, 10),
    })

    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(measurement.failures).toStrictEqual([
      {
        sessionIndex: 0,
        turnIndex: 0,
        reason: 'timeout',
        message: 'driver did not stop within the 15 ms turn timeout',
      },
    ])
  })

  it('keeps a completed turn even when send itself times out', async () => {
    const driver = new FakeDriver({
      onSend: (_text, _call, target) => {
        target.push(granted('turn-0'))
        target.push(chunk())
        target.push(committed())
        return new Promise<void>(() => undefined)
      },
    })
    useFakeDriver(driver)

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [] }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      turnTimeoutMs: 15,
      now: scriptedClock(0, 10, 12, 15, 20),
    })

    expect(measurement.turns).toStrictEqual([
      { sessionIndex: 0, turnIndex: 0, ttftMs: 5, totalMs: 10 },
    ])
    expect(measurement.failures).toStrictEqual([])
  })

  it('allows a terminal event later than one macrotask with the default timeout', async () => {
    const driver = new FakeDriver({
      onSend: async (_text, _call, target) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        target.push(granted('turn-0'))
        target.push(chunk())
        target.push(committed())
      },
    })
    useFakeDriver(driver)

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [] }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      now: scriptedClock(0, 10, 20, 30, 40),
    })

    expect(measurement.turns).toStrictEqual([
      { sessionIndex: 0, turnIndex: 0, ttftMs: 20, totalMs: 30 },
    ])
  })

  it('propagates a rejected close from the finally block', async () => {
    const driver = new FakeDriver({
      onSend: (_text, _call, target) => {
        target.push(granted('turn-0'))
        target.push(chunk())
        target.push(committed())
      },
      onClose: (target) => {
        target.end()
        throw new Error('close failed')
      },
    })
    useFakeDriver(driver)

    await expect(
      measureSessionLatency({
        modelFactory: () => ({ model: fakeModel(), timings: [] }),
        sessions: 1,
        turnsPerSession: 1,
        prompt: () => 'go',
        now: scriptedClock(0, 10, 20, 30, 40),
      }),
    ).rejects.toThrow(new Error('close failed'))
  })

  it('propagates a rejected dispose from the finally block', async () => {
    const driver = new FakeDriver({
      onSend: (_text, _call, target) => {
        target.push(granted('turn-0'))
        target.push(chunk())
        target.push(committed())
      },
    })
    useFakeDriver(driver)
    const dispose = (): Promise<void> => Promise.reject(new Error('dispose failed'))

    await expect(
      measureSessionLatency({
        modelFactory: () => ({ model: fakeModel(dispose), timings: [] }),
        sessions: 1,
        turnsPerSession: 1,
        prompt: () => 'go',
        now: scriptedClock(0, 10, 20, 30, 40),
      }),
    ).rejects.toThrow(new Error('dispose failed'))
  })

  it('returns the measurement when close and the event stream never settle', async () => {
    const driver = new FakeDriver({
      onSend: (_text, _call, target) => {
        target.push(granted('turn-0'))
        target.push(chunk())
        target.push(committed())
      },
      onClose: () => new Promise<void>(() => undefined),
    })
    useFakeDriver(driver)
    const startedAt = Date.now()

    const measurement = await measureSessionLatency({
      modelFactory: () => ({ model: fakeModel(), timings: [] }),
      sessions: 1,
      turnsPerSession: 1,
      prompt: () => 'go',
      turnTimeoutMs: 10,
      now: scriptedClock(0, 10, 20, 30, 40),
    })

    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(measurement.turns).toHaveLength(1)
  })
})

describe('summarizeLatency', () => {
  it('fails on an empty measurement instead of inventing a summary', () => {
    expect(() => summarizeLatency(emptyMeasurement())).toThrow(
      new RangeError('Cannot summarize an empty sample'),
    )
  })

  it('summarizes every axis and leaves provider and local absent when no turn has them', () => {
    const summary = summarizeLatency({
      turns: [
        { sessionIndex: 0, turnIndex: 0, ttftMs: 10, totalMs: 20 },
        { sessionIndex: 0, turnIndex: 1, ttftMs: 30, totalMs: 40 },
      ],
      sessionStarts: [{ sessionIndex: 0, ms: 7 }],
      failures: [],
    })

    expect(summary.providerTtftMs).toBeUndefined()
    expect(summary.localOverheadMs).toBeUndefined()
    expect(summary.sessionStartToFirstChunkMs).toStrictEqual({
      count: 1,
      min: 7,
      max: 7,
      mean: 7,
      p50: 7,
      p95: 7,
      p99: 7,
    })
    expect(summary.turnTtftMs.count).toBe(2)
    expect(summary.turnTtftMs.min).toBe(10)
    expect(summary.turnTtftMs.max).toBe(30)
    expect(summary.turnTtftMs.mean).toBe(20)
    expect(summary.turnTtftMs.p50).toBe(20)
    expect(summary.turnTtftMs.p95).toBeCloseTo(29, 10)
    expect(summary.turnTotalMs.count).toBe(2)
  })

  it('summarizes only the turns that carry provider and local samples', () => {
    const summary = summarizeLatency({
      turns: [
        {
          sessionIndex: 0,
          turnIndex: 0,
          ttftMs: 10,
          totalMs: 20,
          providerTtftMs: 5,
          localOverheadMs: 5,
        },
        { sessionIndex: 0, turnIndex: 1, ttftMs: 30, totalMs: 40 },
        {
          sessionIndex: 0,
          turnIndex: 2,
          ttftMs: 50,
          totalMs: 60,
          providerTtftMs: 15,
        },
      ],
      sessionStarts: [
        { sessionIndex: 0, ms: 7 },
        { sessionIndex: 0, ms: 9 },
      ],
      failures: [],
    })

    expect(summary.sessionStartToFirstChunkMs.count).toBe(2)
    expect(summary.sessionStartToFirstChunkMs.mean).toBe(8)
    expect(summary.providerTtftMs).toStrictEqual({
      count: 2,
      min: 5,
      max: 15,
      mean: 10,
      p50: 10,
      p95: 14.5,
      p99: 14.9,
    })
    expect(summary.localOverheadMs).toStrictEqual({
      count: 1,
      min: 5,
      max: 5,
      mean: 5,
      p50: 5,
      p95: 5,
      p99: 5,
    })
  })

  it('leaves provider absent when only local overhead is present', () => {
    const summary = summarizeLatency({
      turns: [{ sessionIndex: 0, turnIndex: 0, ttftMs: 10, totalMs: 20, localOverheadMs: 4 }],
      sessionStarts: [{ sessionIndex: 0, ms: 3 }],
      failures: [],
    })

    expect(summary.providerTtftMs).toBeUndefined()
    expect(summary.localOverheadMs?.count).toBe(1)
    expect(summary.localOverheadMs?.mean).toBe(4)
  })
})
