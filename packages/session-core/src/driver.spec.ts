import { FakeClock, createSeededRandom } from '@rp/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  AsyncEventQueue,
  createTextSessionDriver,
  guardTurnEvents,
  type SessionEvent,
  type SessionDriver,
  type TextModelChunk,
  type TextModelPort,
  type TextModelRequest,
  type TextModelUsage,
} from './index.js'
import { SessionDriverError } from './driver.js'

/**
 * Scripted model used to drive the session in tests. It records every request
 * so the conversation it sees can be asserted, not just the output.
 */
interface ScriptedModel extends TextModelPort {
  readonly requests: TextModelRequest[]
}

interface ScriptedOptions {
  readonly chunks: readonly string[]
  /** Throw after yielding this many chunks. */
  readonly failAfter?: number
  /** End the iterator after the last chunk without ever marking `done`. */
  readonly endWithoutDone?: boolean
  /** Yield one extra chunk after the one marked `done`. */
  readonly chunkAfterDone?: boolean
  /** Usage reported on the final chunk. */
  readonly usage?: TextModelUsage
  /** Run before a chunk is yielded (the clock test uses it). */
  readonly beforeChunk?: (index: number) => Promise<void>
}

function scriptedModel(options: ScriptedOptions): ScriptedModel {
  const requests: TextModelRequest[] = []

  return {
    kind: 'canned',
    label: 'scripted',
    requests,
    async *complete(request: TextModelRequest): AsyncIterable<TextModelChunk> {
      requests.push(request)

      for (const [index, text] of options.chunks.entries()) {
        if (options.failAfter === index) throw new Error('provider failed')
        await options.beforeChunk?.(index)
        await Promise.resolve()
        const last = index === options.chunks.length - 1
        yield {
          text,
          done: last && options.endWithoutDone !== true,
          ...(last && options.usage !== undefined ? { usage: options.usage } : {}),
        }
      }

      if (options.chunkAfterDone === true) {
        await Promise.resolve()
        yield { text: 'late', done: true }
      }
    },
  }
}

interface SessionHarness {
  readonly driver: SessionDriver
  readonly events: SessionEvent[]
  onEvent(listener: (event: SessionEvent) => void): void
  finished(): Promise<void>
}

function openSession(
  model: TextModelPort,
  options: {
    grantTtlMs?: number
    clock?: FakeClock
    maxHistoryMessages?: number
    instructions?: readonly { role: 'system'; content: string }[]
    locale?: string
  } = {},
): SessionHarness {
  const clock = options.clock ?? new FakeClock(0)
  const driver = createTextSessionDriver({
    sessionId: 'session-1',
    lang: 'en',
    taskId: 'task-1',
    clockMode: 'simulated',
    clock,
    model,
    grantTtlMs: options.grantTtlMs,
    maxHistoryMessages: options.maxHistoryMessages,
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
  })

  const events: SessionEvent[] = []
  let listener: ((event: SessionEvent) => void) | undefined

  const consumer = (async () => {
    for await (const event of driver.events) {
      events.push(event)
      listener?.(event)
    }
  })()

  return {
    driver,
    events,
    onEvent(next) {
      listener = next
    },
    finished: () => consumer,
  }
}

function types(events: readonly SessionEvent[]): string[] {
  return events.map((event) => event.type)
}

function chunks(events: readonly SessionEvent[]): string[] {
  return events
    .filter((event) => event.type === 'persona.response.chunk')
    .map((event) => (event.payload as { text: string }).text)
}

async function runToEnd(harness: SessionHarness): Promise<SessionEvent[]> {
  await harness.driver.close()
  await harness.finished()
  return harness.events
}

/**
 * The D2 invariants, checked over a complete event stream:
 * - no chunk after the turn's terminal event;
 * - exactly one terminal event per turn;
 * - chunk sequence numbers start at 0 and increase by 1 per grant;
 * - the §3.2 guard stays clean.
 */
function expectCancellationInvariants(events: readonly SessionEvent[]): void {
  const terminalByGrant = new Map<string, 'committed' | 'cancelled'>()
  const lastSequence = new Map<string, number>()
  let cancelledCount = 0

  for (const event of events) {
    if (event.type === 'persona.response.chunk') {
      const { grantId, sequence } = event.payload
      expect(terminalByGrant.has(grantId), `chunk after terminal for ${grantId}`).toBe(false)
      const last = lastSequence.get(grantId)
      expect(sequence, `sequence for ${grantId}`).toBe(last === undefined ? 0 : last + 1)
      lastSequence.set(grantId, sequence)
      continue
    }

    if (
      event.type === 'persona.response.committed' ||
      event.type === 'persona.response.cancelled'
    ) {
      const { grantId } = event.payload
      expect(terminalByGrant.has(grantId), `second terminal for ${grantId}`).toBe(false)
      terminalByGrant.set(
        grantId,
        event.type === 'persona.response.committed' ? 'committed' : 'cancelled',
      )
      if (event.type === 'persona.response.cancelled') cancelledCount += 1
    }
  }

  // One cancelled event per cancelled turn is guaranteed by the single-terminal
  // check above; this keeps the count explicit for the fuzz report.
  expect([...terminalByGrant.values()].filter((value) => value === 'cancelled')).toHaveLength(
    cancelledCount,
  )
  expect(guardTurnEvents(events).ok).toBe(true)
}

describe('text session driver', () => {
  it('opens with session.started before any turn', async () => {
    const harness = openSession(scriptedModel({ chunks: ['Hello'] }))
    const events = await runToEnd(harness)

    expect(events[0]).toEqual({
      type: 'session.started',
      payload: {
        sessionId: 'session-1',
        clockMode: 'simulated',
        lang: 'en',
        taskId: 'task-1',
      },
    })
    expect(events.at(-1)?.type).toBe('session.completed')
  })

  it('streams one reply and commits it under a turn grant', async () => {
    const model = scriptedModel({ chunks: ['Good ', 'morning'] })
    const harness = openSession(model)

    await harness.driver.send('Hi there')
    const events = await runToEnd(harness)

    expect(types(events)).toEqual([
      'session.started',
      'user.utterance.committed',
      'turn.opened',
      'turn.granted',
      'persona.response.started',
      'persona.response.chunk',
      'persona.response.chunk',
      'persona.response.committed',
      'session.completed',
    ])

    expect(chunks(events)).toEqual(['Good ', 'morning'])
    const committed = events.find((event) => event.type === 'persona.response.committed')
    expect(committed?.payload).toEqual({ grantId: 'session-1-grant-1', text: 'Good morning' })

    const user = events.find((event) => event.type === 'user.utterance.committed')
    expect(user?.payload).toEqual({ text: 'Hi there' })
    const opened = events.find((event) => event.type === 'turn.opened')
    expect(opened?.payload).toEqual({ turnId: 'session-1-turn-1' })
    const granted = events.find((event) => event.type === 'turn.granted')
    expect(granted?.payload).toMatchObject({
      grant: { turnId: 'session-1-turn-1', personaId: 'persona-1' },
    })

    const cancelled = events.filter((event) => event.type === 'persona.response.cancelled')
    expect(cancelled).toHaveLength(0)
    expect(guardTurnEvents(events).ok).toBe(true)
  })

  it('uses the injected persona id and clock mode', async () => {
    const driver = createTextSessionDriver({
      sessionId: 'session-1',
      lang: 'en',
      clockMode: 'wall',
      personaId: 'tutor',
      clock: new FakeClock(0),
      model: scriptedModel({ chunks: ['ok'] }),
    })
    const events: SessionEvent[] = []
    const consumer = (async () => {
      for await (const event of driver.events) events.push(event)
    })()

    await driver.send('go')
    await driver.close()
    await consumer

    expect(events[0]?.payload).toMatchObject({ clockMode: 'wall' })
    expect(events.find((event) => event.type === 'turn.granted')?.payload).toMatchObject({
      grant: { personaId: 'tutor' },
    })
  })

  it('sends the conversation so far to the model', async () => {
    const model = scriptedModel({ chunks: ['One'] })
    const harness = openSession(model)

    await harness.driver.send('first')
    await harness.driver.send('second')
    await runToEnd(harness)

    expect(model.requests).toHaveLength(2)
    expect(model.requests[0]?.messages).toEqual([{ role: 'user', content: 'first' }])
    expect(model.requests[0]?.metadata).toEqual({ lang: 'en' })
    expect(model.requests[0]?.requestId).toBe('session-1-turn-1')
    expect(model.requests[1]?.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'One' },
      { role: 'user', content: 'second' },
    ])
  })

  it('starts a greeting turn without a learner utterance', async () => {
    const model = scriptedModel({ chunks: ['Hello'] })
    const harness = openSession(model)

    await harness.driver.start()
    const events = await runToEnd(harness)

    expect(types(events)).toContain('turn.granted')
    expect(events.some((event) => event.type === 'user.utterance.committed')).toBe(false)
    expect(
      events.find((event) => event.type === 'persona.response.committed')?.payload,
    ).toMatchObject({ text: 'Hello' })
    expect(model.requests[0]?.messages).toEqual([])
  })

  it('only opens an empty session with start()', async () => {
    const model = scriptedModel({ chunks: ['Hello'] })
    const harness = openSession(model)

    await harness.driver.send('first')
    await expect(harness.driver.start()).rejects.toMatchObject({
      name: 'SessionDriverError',
      message: 'start() only opens an empty session',
    })
    await runToEnd(harness)
  })

  it('requires a single-persona model', () => {
    expect(() =>
      createTextSessionDriver({
        sessionId: 'session-1',
        lang: 'en',
        clock: new FakeClock(0),
      }),
    ).toThrow(/requires a model/)
  })

  it('fails the event queue past the configured bound', async () => {
    const driver = createTextSessionDriver({
      sessionId: 'session-1',
      lang: 'en',
      clockMode: 'simulated',
      clock: new FakeClock(0),
      model: scriptedModel({ chunks: ['Hello'] }),
      maxQueuedEvents: 1,
    })

    await driver.start()

    await expect(
      (async () => {
        for await (const _event of driver.events) {
          // The bound is exceeded before the consumer starts.
        }
      })(),
    ).rejects.toThrow(/not keeping up/)
  })

  it('keeps the greeting as the first assistant turn and then sends the learner reply', async () => {
    const model = scriptedModel({ chunks: ['Hello'] })
    const harness = openSession(model)

    await harness.driver.start()
    await harness.driver.send('reply')
    await runToEnd(harness)

    expect(model.requests).toHaveLength(2)
    expect(model.requests[1]?.messages).toEqual([
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'reply' },
    ])
  })

  it('prepends prepared instructions once and keeps them out of history', async () => {
    const model = scriptedModel({ chunks: ['ok'] })
    const harness = openSession(model, {
      instructions: [{ role: 'system', content: 'SYSTEM INSTRUCTIONS' }],
      locale: 'en-GB',
    })

    await harness.driver.send('first')
    await harness.driver.send('second')
    await runToEnd(harness)

    expect(model.requests[0]?.messages).toEqual([
      { role: 'system', content: 'SYSTEM INSTRUCTIONS' },
      { role: 'user', content: 'first' },
    ])
    expect(model.requests[1]?.messages).toEqual([
      { role: 'system', content: 'SYSTEM INSTRUCTIONS' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second' },
    ])
    expect(model.requests[0]?.metadata).toEqual({ lang: 'en', locale: 'en-GB' })
  })

  it('never trims the committed greeting', async () => {
    const model = scriptedModel({ chunks: ['Hello'] })
    const harness = openSession(model, { maxHistoryMessages: 3 })

    await harness.driver.start()
    await harness.driver.send('one')
    await harness.driver.send('two')
    await runToEnd(harness)

    const messages = model.requests.at(-1)?.messages ?? []
    expect(messages[0]).toEqual({ role: 'assistant', content: 'Hello' })
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'two' })
    expect(messages.length).toBeLessThanOrEqual(3)
  })

  it('interrupts an in-flight greeting without committing it', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'silent-greeting',
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
    const harness = openSession(model, { grantTtlMs: 60_000 })

    const starting = harness.driver.start()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await harness.driver.interrupt()
    await starting
    const events = await runToEnd(harness)

    expect(events.some((event) => event.type === 'persona.response.committed')).toBe(false)
    expect(
      events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({ reason: 'interrupted' })
  })

  it('rejects start() after a greeting turn counter exists', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'silent-start',
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
    const harness = openSession(model, { grantTtlMs: 60_000 })
    const starting = harness.driver.start()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await harness.driver.interrupt()
    await starting

    // The turn counter advanced even though no greeting committed.
    await expect(harness.driver.start()).rejects.toBeInstanceOf(SessionDriverError)
    await runToEnd(harness)
  })

  it('rejects start() after close', async () => {
    const harness = openSession(scriptedModel({ chunks: ['ok'] }))
    await harness.driver.close()
    await expect(harness.driver.start()).rejects.toMatchObject({
      name: 'SessionClosedError',
      message: 'the session is closed; send() is no longer accepted',
    })
  })

  it('uses the general instructions for the greeting when no greeting pack is set', async () => {
    const model = scriptedModel({ chunks: ['ok'] })
    const harness = openSession(model, {
      instructions: [{ role: 'system', content: 'FULL' }],
    })

    await harness.driver.start()
    await runToEnd(harness)

    expect(model.requests[0]?.messages).toEqual([{ role: 'system', content: 'FULL' }])
  })

  it('lets a user turn supersede an in-flight greeting', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'slow-greeting',
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
    const harness = openSession(model, { grantTtlMs: 20 })
    const starting = harness.driver.start()
    await new Promise((resolve) => setTimeout(resolve, 5))

    const sending = harness.driver.send('hello')
    await sending
    await starting
    const events = await runToEnd(harness)

    expect(
      events.filter((event) => event.type === 'persona.response.cancelled').length,
    ).toBeGreaterThanOrEqual(1)
    expect(types(events)).toContain('user.utterance.committed')
  })

  it('keeps the greeting first after later turns', async () => {
    const model = scriptedModel({ chunks: ['Hello'] })
    const harness = openSession(model, { maxHistoryMessages: 2 })

    // A successful greeting is the only thing that is protected from trimming.
    await harness.driver.start()
    await harness.driver.send('one')
    await harness.driver.send('two')
    await runToEnd(harness)

    expect(model.requests.at(-1)?.messages[0]).toEqual({
      role: 'assistant',
      content: 'Hello',
    })
  })

  it('keeps a one-message history with a greeting', async () => {
    const model = scriptedModel({ chunks: ['Hello'] })
    const harness = openSession(model, { maxHistoryMessages: 1 })

    await harness.driver.start()
    await harness.driver.send('one')
    await runToEnd(harness)

    expect(model.requests.at(-1)?.messages).toHaveLength(1)
    expect(model.requests.at(-1)?.messages[0]).toEqual({
      role: 'assistant',
      content: 'Hello',
    })
  })

  it('does not mark a provider-failed greeting as committed', async () => {
    let calls = 0
    const model: TextModelPort = {
      kind: 'canned',
      label: 'fail-first',
      async *complete() {
        calls += 1
        if (calls === 1) throw new Error('first call failed')
        yield { text: 'Hello', done: true }
      },
    }
    const harness = openSession(model)

    await harness.driver.start()
    await harness.driver.send('one')
    await runToEnd(harness)

    const committed = harness.events.filter((event) => event.type === 'persona.response.committed')
    expect(committed).toHaveLength(1)
    expect(committed[0]?.payload).toMatchObject({ text: 'Hello' })
  })

  it('describes a non-Error provider throw without inventing a message', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'string-throw',
      complete() {
        // A provider can reject with a plain string; the driver must not crash
        // while formatting the cause.
        throw 'boom'
      },
    }
    const harness = openSession(model)

    await harness.driver.send('go')
    const events = await runToEnd(harness)
    const cancelled = events.find((event) => event.type === 'persona.response.cancelled')

    expect(cancelled?.payload).toMatchObject({
      reason: 'provider_failure',
      detail: 'Error: boom',
    })
  })

  it('bounds a long provider failure detail to one line', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'long-error',
      complete() {
        throw new Error(`line one\n\n${'x'.repeat(400)}`)
      },
    }
    const harness = openSession(model)

    await harness.driver.send('go')
    const events = await runToEnd(harness)
    const cancelled = events.find((event) => event.type === 'persona.response.cancelled')
    const detail = (cancelled?.payload as { detail?: string }).detail

    expect(detail).toBeDefined()
    expect(detail?.length).toBeLessThanOrEqual(200)
    expect(detail).toContain('Error: line one x')
    expect(detail?.endsWith('...')).toBe(true)
    expect(detail).not.toContain('\n')
  })

  it('closes a provider iterator that has no return method', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'no-return',
      complete() {
        let sent = false
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<TextModelChunk>> {
                if (sent) return Promise.resolve({ value: undefined, done: true })
                sent = true
                return Promise.resolve({ value: { text: 'ok', done: true }, done: false })
              },
            }
          },
        }
      },
    }
    const harness = openSession(model)

    await harness.driver.send('go')
    const events = await runToEnd(harness)

    expect(
      events.find((event) => event.type === 'persona.response.committed')?.payload,
    ).toMatchObject({ text: 'ok' })
  })

  it('caps the context history to the configured number of messages', async () => {
    const model = scriptedModel({ chunks: ['ok'] })
    const harness = openSession(model, { maxHistoryMessages: 3 })

    for (let turn = 0; turn < 6; turn += 1) {
      await harness.driver.send(`turn-${turn}`)
    }
    await runToEnd(harness)

    expect(model.requests).toHaveLength(6)
    expect(model.requests.at(-1)?.messages).toHaveLength(3)
    // Trimming keeps a user turn first, so the pair is not cut in half.
    expect(model.requests.at(-1)?.messages[0]?.role).toBe('user')
  })

  it('accepts a history limit of one message', async () => {
    const model = scriptedModel({ chunks: ['ok'] })
    const harness = openSession(model, { maxHistoryMessages: 1 })

    await harness.driver.send('one')
    await harness.driver.send('two')
    await runToEnd(harness)

    expect(model.requests.at(-1)?.messages).toHaveLength(1)
  })

  it('does not trim history before the limit', async () => {
    const model = scriptedModel({ chunks: ['ok'] })
    const harness = openSession(model, { maxHistoryMessages: 10 })

    await harness.driver.send('one')
    await harness.driver.send('two')
    await runToEnd(harness)

    expect(model.requests.at(-1)?.messages).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'two' },
    ])
  })

  it('passes an abort signal to the model', async () => {
    let signal: AbortSignal | undefined
    const model: TextModelPort = {
      kind: 'canned',
      label: 'signal-capture',
      complete(_request, options) {
        signal = options?.signal
        return (async function* () {
          yield { text: 'ok', done: true }
        })()
      },
    }
    const harness = openSession(model)

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('rejects a non-positive history limit', () => {
    const model = scriptedModel({ chunks: ['ok'] })

    expect(() => openSession(model, { maxHistoryMessages: 0 })).toThrow(/positive integer/)
    expect(() => openSession(model, { maxHistoryMessages: 1.5 })).toThrow(/positive integer/)
    expect(() => openSession(model, { maxHistoryMessages: -1 })).toThrow(/positive integer/)
  })

  it('rejects a non-positive grant TTL', () => {
    const model = scriptedModel({ chunks: ['ok'] })

    expect(() => openSession(model, { grantTtlMs: 0 })).toThrow(/positive integer/)
    expect(() => openSession(model, { grantTtlMs: -1 })).toThrow(/positive integer/)
    expect(() => openSession(model, { grantTtlMs: 1.5 })).toThrow(/positive integer/)
  })

  it('accepts a one-millisecond grant TTL', () => {
    const model = scriptedModel({ chunks: ['ok'] })

    expect(() => openSession(model, { grantTtlMs: 1 })).not.toThrow()
  })

  it('trims a leading assistant message before the next request', async () => {
    const model = scriptedModel({ chunks: ['ok'] })
    const harness = openSession(model, { maxHistoryMessages: 4 })

    for (let turn = 0; turn < 3; turn += 1) {
      await harness.driver.send(`turn-${turn}`)
    }
    await runToEnd(harness)

    expect(model.requests.at(-1)?.messages[0]?.role).toBe('user')
  })

  it('clears the grant deadline timer after a normal turn', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    try {
      const harness = openSession(scriptedModel({ chunks: ['ok'] }))
      await harness.driver.send('go')
      await runToEnd(harness)
      // One clear for the grant deadline and one for the bounded close timer.
      expect(clear.mock.calls.length).toBeGreaterThanOrEqual(2)
    } finally {
      clear.mockRestore()
    }
  })

  it('clears its timers after a normal turn', async () => {
    const before = process
      .getActiveResourcesInfo()
      .filter((resource) => resource === 'Timeout').length
    const harness = openSession(scriptedModel({ chunks: ['ok'] }))

    await harness.driver.send('go')
    await runToEnd(harness)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const after = process
      .getActiveResourcesInfo()
      .filter((resource) => resource === 'Timeout').length
    expect(after).toBeLessThanOrEqual(before)
  })

  it('waits for the bounded close window when the provider return never resolves', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'never-returns',
      complete() {
        let sent = false
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<TextModelChunk>> {
                if (sent) return Promise.resolve({ done: true, value: undefined })
                sent = true
                return Promise.resolve({ done: false, value: { text: 'ok', done: true } })
              },
              return(): Promise<IteratorResult<TextModelChunk>> {
                return new Promise(() => undefined)
              },
            }
          },
        }
      },
    }
    const harness = openSession(model)
    const startedAt = Date.now()

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900)
    expect(harness.events.some((event) => event.type === 'persona.response.committed')).toBe(true)
  })

  it('does not hang when the provider never finishes closing its stream', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'slow-close',
      complete() {
        let sent = false
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<TextModelChunk>> {
                if (sent) return Promise.resolve({ done: true, value: undefined })
                sent = true
                return Promise.resolve({ done: false, value: { text: 'ok', done: true } })
              },
              return(): Promise<IteratorResult<TextModelChunk>> {
                return new Promise(() => undefined)
              },
            }
          },
        }
      },
    }
    const harness = openSession(model)
    const startedAt = Date.now()

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(harness.events.some((event) => event.type === 'persona.response.committed')).toBe(true)
  })

  it('drops a chunk that arrives after the abort landed', async () => {
    let abort: () => void = () => undefined
    const model: TextModelPort = {
      kind: 'canned',
      label: 'late-chunk',
      complete() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<TextModelChunk>> {
                return new Promise((resolve) => {
                  resolve({
                    done: false,
                    get value(): TextModelChunk {
                      abort()
                      return { text: 'late', done: false }
                    },
                  })
                })
              },
            }
          },
        }
      },
    }
    const harness = openSession(model)
    abort = () => void harness.driver.interrupt()

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(chunks(harness.events)).toEqual([])
    expect(
      harness.events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({ reason: 'interrupted' })
  })

  it('preserves partial text, cancels once, and lets the next turn succeed', async () => {
    const model = scriptedModel({ chunks: ['One ', 'two ', 'three'] })
    const harness = openSession(model)
    let seen = 0

    harness.onEvent((event) => {
      if (event.type !== 'persona.response.chunk') return
      seen += 1
      if (seen === 2) void harness.driver.interrupt()
    })

    await harness.driver.send('go')
    const cancelled = harness.events.filter((event) => event.type === 'persona.response.cancelled')
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]?.payload).toEqual({
      grantId: 'session-1-grant-1',
      reason: 'interrupted',
      partialText: 'One two ',
    })
    expect(chunks(harness.events)).toEqual(['One ', 'two '])

    await harness.driver.send('again')
    await runToEnd(harness)

    expect(model.requests[1]?.messages).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'One two ' },
      { role: 'user', content: 'again' },
    ])
    const committed = harness.events.filter((event) => event.type === 'persona.response.committed')
    expect(committed).toHaveLength(1)
    expect(committed[0]?.payload).toMatchObject({ text: 'One two three' })
    expect(guardTurnEvents(harness.events).ok).toBe(true)
  })

  it('cancels before every chunk without late output', async () => {
    const total = 4

    for (let interruptAt = 0; interruptAt < total; interruptAt += 1) {
      const model = scriptedModel({ chunks: ['a', 'b', 'c', 'd'] })
      const harness = openSession(model)
      let seen = 0
      let interrupted = false

      harness.onEvent((event) => {
        if (interrupted) return
        if (interruptAt === 0 && event.type === 'persona.response.started') {
          interrupted = true
          void harness.driver.interrupt()
          return
        }
        if (event.type !== 'persona.response.chunk') return
        seen += 1
        if (seen === interruptAt) {
          interrupted = true
          void harness.driver.interrupt()
        }
      })

      await harness.driver.send('go')

      const cancelledAt = harness.events.findIndex(
        (event) => event.type === 'persona.response.cancelled',
      )
      expect(cancelledAt, `boundary ${interruptAt}`).toBeGreaterThan(-1)

      const afterCancel = harness.events.slice(cancelledAt + 1)
      expect(afterCancel.some((event) => event.type === 'persona.response.chunk')).toBe(false)
      expect(afterCancel.some((event) => event.type === 'persona.response.committed')).toBe(false)
      expect(
        harness.events.filter((event) => event.type === 'persona.response.cancelled'),
      ).toHaveLength(1)

      const sequences = harness.events
        .filter((event) => event.type === 'persona.response.chunk')
        .map((event) => (event.payload as { sequence: number }).sequence)
      expect(sequences).toEqual(sequences.map((_value, index) => index))

      await harness.driver.send('again')
      await runToEnd(harness)
      expect(guardTurnEvents(harness.events).ok, `guard at boundary ${interruptAt}`).toBe(true)
    }
  })

  it('holds the cancellation invariants across seeded interleavings', async () => {
    const random = createSeededRandom(20261107)

    for (let trial = 0; trial < 60; trial += 1) {
      const chunkCount = 1 + random.int(5)
      const interruptAt = random.int(chunkCount + 2) - 1 // -1 = never, 0 = before the first chunk
      const doubleInterrupt = random.bool(0.3)
      const closeDuringStream = random.bool(0.2)
      const closeAt = closeDuringStream ? random.int(chunkCount + 1) : -1

      const model = scriptedModel({
        chunks: Array.from({ length: chunkCount }, (_value, index) => `c${index} `),
      })
      const harness = openSession(model)
      let chunksSeen = 0
      let fired = false

      harness.onEvent((event) => {
        if (fired) return
        if (event.type === 'persona.response.chunk') chunksSeen += 1

        const atStart = event.type === 'persona.response.started'
        const atChunk = event.type === 'persona.response.chunk'
        const triggerAt = closeDuringStream ? closeAt : interruptAt
        const reached = triggerAt === 0 ? atStart : atChunk && chunksSeen === triggerAt
        if (!reached) return

        fired = true
        if (closeDuringStream) {
          void harness.driver.close()
          return
        }
        void harness.driver.interrupt()
        if (doubleInterrupt) void harness.driver.interrupt()
      })

      const sending = harness.driver.send('go')
      await sending
      if (!closeDuringStream) await harness.driver.close()
      await harness.finished()

      expectCancellationInvariants(harness.events)
    }
  })

  it('records provider usage on the committed event', async () => {
    const usage = { inputTokens: 12, outputTokens: 4, costUsd: 0.00002 }
    const model = scriptedModel({ chunks: ['Hello'], usage })
    const harness = openSession(model)

    await harness.driver.send('go')
    const events = await runToEnd(harness)

    expect(events.find((event) => event.type === 'persona.response.committed')?.payload).toEqual({
      grantId: 'session-1-grant-1',
      text: 'Hello',
      usage,
    })
  })

  it('omits usage when the provider does not report it', async () => {
    const model = scriptedModel({ chunks: ['Hello'] })
    const harness = openSession(model)

    await harness.driver.send('go')
    const events = await runToEnd(harness)

    expect(events.find((event) => event.type === 'persona.response.committed')?.payload).toEqual({
      grantId: 'session-1-grant-1',
      text: 'Hello',
    })
  })

  it('cancels at the exact grant expiry boundary', async () => {
    const clock = new FakeClock(0)
    const model = scriptedModel({
      chunks: ['one'],
      beforeChunk: async () => {
        await clock.advance(10)
      },
    })
    const harness = openSession(model, { clock, grantTtlMs: 10 })

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(
      harness.events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({ reason: 'timeout', partialText: 'one' })
    expect(harness.events.some((event) => event.type === 'persona.response.committed')).toBe(false)
  })

  it('aborts the signal when the simulated clock expires', async () => {
    const clock = new FakeClock(0)
    let signal: AbortSignal | undefined
    const model: TextModelPort = {
      kind: 'canned',
      label: 'clock-expiry',
      complete(_request, options) {
        signal = options?.signal
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<TextModelChunk>> {
                await clock.advance(10)
                return { done: false, value: { text: 'one', done: false } }
              },
            }
          },
        }
      },
    }
    const harness = openSession(model, { clock, grantTtlMs: 5 })

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(signal?.aborted).toBe(true)
    expect(
      harness.events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({ reason: 'timeout', partialText: 'one' })
  })

  it('times out a silent provider when the clock starts at a non-zero value', async () => {
    const clock = new FakeClock(1_000)
    const model: TextModelPort = {
      kind: 'canned',
      label: 'silent-nonzero-clock',
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
    const harness = openSession(model, { clock, grantTtlMs: 20 })
    const startedAt = Date.now()

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(
      harness.events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({ reason: 'timeout' })
  })

  it('times out a silent provider even when it ignores the abort signal', async () => {
    let signal: AbortSignal | undefined
    const model: TextModelPort = {
      kind: 'canned',
      label: 'silent',
      complete(_request, options) {
        signal = options?.signal
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
    const harness = openSession(model, { grantTtlMs: 20 })
    const startedAt = Date.now()

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(signal?.aborted).toBe(true)
    expect(
      harness.events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({ reason: 'timeout' })
    expect(harness.events.some((event) => event.type === 'persona.response.committed')).toBe(false)
  })

  it('lets interrupt end a silent provider that ignores the abort signal', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'silent-abort',
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
    const harness = openSession(model, { grantTtlMs: 60_000 })

    const sending = harness.driver.send('go')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await harness.driver.interrupt()
    await sending
    await runToEnd(harness)

    expect(
      harness.events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({ reason: 'interrupted' })
  })

  it('ignores an empty chunk without creating a sequence gap', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'empty-chunk',
      async *complete() {
        yield { text: '', done: false }
        yield { text: 'ok', done: true }
      },
    }
    const harness = openSession(model)

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(chunks(harness.events)).toEqual(['ok'])
    expect(
      harness.events.find((event) => event.type === 'persona.response.committed')?.payload,
    ).toMatchObject({ text: 'ok' })
  })

  it('keeps usage from an earlier chunk when the final chunk has none', async () => {
    const usage = { inputTokens: 1, outputTokens: 2 }
    const model: TextModelPort = {
      kind: 'canned',
      label: 'usage-earlier',
      async *complete() {
        yield { text: 'a', done: false, usage }
        yield { text: 'b', done: true }
      },
    }
    const harness = openSession(model)

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(
      harness.events.find((event) => event.type === 'persona.response.committed')?.payload,
    ).toMatchObject({ text: 'ab', usage })
  })

  it('omits usage when the provider reports none', async () => {
    const harness = openSession(scriptedModel({ chunks: ['ok'] }))

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(
      harness.events.find((event) => event.type === 'persona.response.committed')?.payload,
    ).not.toHaveProperty('usage')
  })

  it('cancels when the interrupt lands before the commit', async () => {
    let abort: () => void = () => undefined
    const model: TextModelPort = {
      kind: 'canned',
      label: 'abort-before-commit',
      async *complete() {
        yield { text: 'done', done: true }
        abort()
      },
    }
    const harness = openSession(model)
    abort = () => void harness.driver.interrupt()

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(
      harness.events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({ reason: 'interrupted', partialText: 'done' })
    expect(harness.events.some((event) => event.type === 'persona.response.committed')).toBe(false)
  })

  it('does not append an empty assistant message after an immediate cancel', async () => {
    const requests: TextModelRequest[] = []
    let call = 0
    const model: TextModelPort = {
      kind: 'canned',
      label: 'hang-first',
      async *complete(request, options) {
        requests.push(request)
        call += 1
        if (call === 1) {
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted === true) {
              resolve()
              return
            }
            options?.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          return
        }
        yield { text: 'ok', done: true }
      },
    }
    const harness = openSession(model)
    let interrupted = false

    harness.onEvent((event) => {
      if (interrupted || event.type !== 'persona.response.started') return
      interrupted = true
      void harness.driver.interrupt()
    })

    await harness.driver.send('first')
    await harness.driver.send('second')
    await runToEnd(harness)

    expect(requests[1]?.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ])
    const cancelled = harness.events.find((event) => event.type === 'persona.response.cancelled')
    expect(cancelled?.payload).not.toHaveProperty('partialText')
  })

  it('treats a synchronous complete() throw as a provider failure', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'sync-throw',
      complete() {
        throw new Error('no iterator')
      },
    }
    const harness = openSession(model)

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(
      harness.events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({ reason: 'provider_failure', detail: 'Error: no iterator' })
  })

  it('keeps a provider failure detail on one bounded line', async () => {
    async function detailFor(message: string): Promise<string | undefined> {
      const model: TextModelPort = {
        kind: 'canned',
        label: 'detail',
        complete() {
          throw new Error(message)
        },
      }
      const harness = openSession(model)

      await harness.driver.send('go')
      await runToEnd(harness)

      return (
        harness.events.find((event) => event.type === 'persona.response.cancelled')?.payload as
          { detail?: string } | undefined
      )?.detail
    }

    expect(await detailFor('a\n\n b')).toBe('Error: a b')

    const exact = await detailFor('x'.repeat(193))
    expect(exact).toHaveLength(200)
    expect(exact?.endsWith('...')).toBe(false)

    const long = await detailFor('x'.repeat(400))
    expect(long).toHaveLength(200)
    expect(long?.endsWith('...')).toBe(true)
  })

  it('does nothing when interrupted while idle', async () => {
    const harness = openSession(scriptedModel({ chunks: ['One'] }))

    await harness.driver.interrupt()
    await harness.driver.interrupt()
    const events = await runToEnd(harness)

    expect(types(events)).toEqual(['session.started', 'session.completed'])
  })

  it('does not cancel a reply that already committed', async () => {
    const harness = openSession(scriptedModel({ chunks: ['all ', 'done'] }))

    await harness.driver.send('go')
    await harness.driver.interrupt()
    const events = await runToEnd(harness)

    expect(events.some((event) => event.type === 'persona.response.cancelled')).toBe(false)
    expect(events.filter((event) => event.type === 'persona.response.committed')).toHaveLength(1)
  })

  it('turns a provider error into a provider_failure cancellation, never fabricated output', async () => {
    const model = scriptedModel({ chunks: ['partial ', 'lost'], failAfter: 1 })
    const harness = openSession(model)

    await harness.driver.send('go')
    await runToEnd(harness)

    const cancelled = harness.events.find((event) => event.type === 'persona.response.cancelled')
    expect(cancelled?.payload).toMatchObject({
      grantId: 'session-1-grant-1',
      reason: 'provider_failure',
      partialText: 'partial ',
    })
    expect((cancelled?.payload as { detail?: string }).detail).toBe('Error: provider failed')
    expect(harness.events.some((event) => event.type === 'persona.response.committed')).toBe(false)
    expect(guardTurnEvents(harness.events).ok).toBe(true)
  })

  it('treats a stream that ends without a final chunk as a provider failure', async () => {
    const model = scriptedModel({ chunks: ['partial'], endWithoutDone: true })
    const harness = openSession(model)

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(
      harness.events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({
      reason: 'provider_failure',
      partialText: 'partial',
      detail: 'stream ended without a final chunk',
    })
  })

  it('treats a chunk after the final chunk as a provider failure', async () => {
    const model = scriptedModel({ chunks: ['done'], chunkAfterDone: true })
    const harness = openSession(model)

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(
      harness.events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({
      reason: 'provider_failure',
      detail: 'provider yielded a chunk after the final chunk',
    })
    expect(harness.events.some((event) => event.type === 'persona.response.committed')).toBe(false)
  })

  it('treats a non-string chunk as a provider failure', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'bad-chunk',
      async *complete() {
        yield { text: 42 as unknown as string, done: false }
        yield { text: 'ok', done: true }
      },
    }
    const harness = openSession(model)

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(
      harness.events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({
      reason: 'provider_failure',
      detail: 'provider yielded a non-string chunk',
    })
  })

  it('classifies a provider throw after an interrupt as interrupted', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'throw-on-abort',
      async *complete(_request, options) {
        yield { text: 'one', done: false }
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted === true) {
            resolve()
            return
          }
          options?.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        throw new Error('stream broke while aborting')
      },
    }
    const harness = openSession(model)

    harness.onEvent((event) => {
      if (event.type === 'persona.response.chunk') void harness.driver.interrupt()
    })

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(
      harness.events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({ reason: 'interrupted', partialText: 'one' })
  })

  it('calls the iterator return when an aborted stream closes', async () => {
    let returned = false
    let firstChunkSent = false
    const model: TextModelPort = {
      kind: 'canned',
      label: 'return-on-abort',
      complete(_request, options) {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<TextModelChunk>> {
                if (!firstChunkSent) {
                  firstChunkSent = true
                  return { done: false, value: { text: 'one', done: false } }
                }
                await new Promise<void>((resolve) => {
                  if (options?.signal?.aborted === true) {
                    resolve()
                    return
                  }
                  options?.signal?.addEventListener('abort', () => resolve(), { once: true })
                })
                return { done: true, value: undefined }
              },
              return(): Promise<IteratorResult<TextModelChunk>> {
                returned = true
                return Promise.resolve({ done: true, value: undefined })
              },
            }
          },
        }
      },
    }
    const harness = openSession(model)

    harness.onEvent((event) => {
      if (event.type === 'persona.response.chunk') void harness.driver.interrupt()
    })

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(returned).toBe(true)
    expect(
      harness.events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({ reason: 'interrupted', partialText: 'one' })
  })

  it('cancels a reply that outlives its grant', async () => {
    const clock = new FakeClock(0)
    const model = scriptedModel({
      chunks: ['one', 'two'],
      beforeChunk: async () => {
        await clock.advance(10)
      },
    })
    const harness = openSession(model, { clock, grantTtlMs: 5 })

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(
      harness.events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({ reason: 'timeout', partialText: 'one' })
  })

  it('supersedes an in-flight reply when a new utterance arrives', async () => {
    const model = scriptedModel({ chunks: ['slow ', 'reply'] })
    const harness = openSession(model)
    let second: Promise<void> | undefined

    harness.onEvent((event) => {
      if (event.type !== 'persona.response.chunk' || second !== undefined) return
      second = harness.driver.send('second')
    })

    const first = harness.driver.send('first')
    await first
    await second
    await runToEnd(harness)

    const cancelled = harness.events.filter((event) => event.type === 'persona.response.cancelled')
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]?.payload).toMatchObject({ grantId: 'session-1-grant-1' })

    const committed = harness.events.filter((event) => event.type === 'persona.response.committed')
    expect(committed).toHaveLength(1)
    expect(committed[0]?.payload).toMatchObject({
      grantId: 'session-1-grant-2',
      text: 'slow reply',
    })
    expect(guardTurnEvents(harness.events).ok).toBe(true)
  })

  it('cancels an in-flight reply before session.completed on close', async () => {
    const model = scriptedModel({ chunks: ['slow ', 'reply'] })
    const harness = openSession(model)
    const started = Promise.withResolvers<void>()

    harness.onEvent((event) => {
      if (event.type === 'persona.response.started') started.resolve()
    })

    const sending = harness.driver.send('go')
    await started.promise
    await harness.driver.close()
    await sending
    await harness.finished()

    const cancelledAt = harness.events.findIndex(
      (event) => event.type === 'persona.response.cancelled',
    )
    expect(cancelledAt).toBeGreaterThan(-1)
    expect(harness.events.at(-1)?.type).toBe('session.completed')
    expect(
      harness.events
        .slice(cancelledAt + 1)
        .some((event) => event.type === 'persona.response.chunk'),
    ).toBe(false)
    expect(guardTurnEvents(harness.events).ok).toBe(true)
  })

  it('closes once and rejects further utterances', async () => {
    const harness = openSession(scriptedModel({ chunks: ['One'] }))
    await harness.driver.close()
    await harness.driver.close()
    await harness.finished()

    expect(types(harness.events)).toEqual(['session.started', 'session.completed'])
    await expect(harness.driver.send('after close')).rejects.toMatchObject({
      name: 'SessionClosedError',
      message: 'the session is closed; send() is no longer accepted',
    })
  })

  it('shares one closing promise while an interrupt is in flight', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'closable',
      async *complete(_request, options) {
        yield { text: 'one', done: false }
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted === true) {
            resolve()
            return
          }
          options?.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }
    const harness = openSession(model)
    let firstClose: Promise<void> | undefined
    let secondClose: Promise<void> | undefined

    harness.onEvent((event) => {
      if (event.type === 'persona.response.chunk') {
        firstClose = harness.driver.close()
        secondClose = harness.driver.close()
      }
    })

    await harness.driver.send('go')
    await Promise.all([firstClose, secondClose])
    await harness.finished()

    expect(harness.events.filter((event) => event.type === 'session.completed')).toHaveLength(1)
    expect(
      harness.events.filter((event) => event.type === 'persona.response.cancelled'),
    ).toHaveLength(1)
  })

  it('rejects an empty utterance without emitting a user event', async () => {
    const harness = openSession(scriptedModel({ chunks: ['One'] }))

    await expect(harness.driver.send('   ')).rejects.toMatchObject({
      name: 'SessionDriverError',
      message: 'an utterance must not be empty',
    })
    const events = await runToEnd(harness)

    expect(events.some((event) => event.type === 'user.utterance.committed')).toBe(false)
  })

  it('defaults the clock mode to simulated', async () => {
    const driver = createTextSessionDriver({
      sessionId: 'default-mode',
      lang: 'en',
      clock: new FakeClock(0),
      model: scriptedModel({ chunks: ['ok'] }),
    })
    const events: SessionEvent[] = []
    const consumer = (async () => {
      for await (const event of driver.events) events.push(event)
    })()
    await driver.close()
    await consumer

    expect(events[0]).toMatchObject({
      type: 'session.started',
      payload: { clockMode: 'simulated', lang: 'en' },
    })
    expect(events[0]?.payload).not.toHaveProperty('taskId')
  })

  it('defaults the persona, grant TTL and history bound', async () => {
    const model = scriptedModel({ chunks: ['ok'] })
    const driver = createTextSessionDriver({
      sessionId: 'defaults',
      lang: 'en',
      clock: new FakeClock(0),
      model,
    })
    const events: SessionEvent[] = []
    const consumer = (async () => {
      for await (const event of driver.events) events.push(event)
    })()
    await driver.send('hello')
    await driver.close()
    await consumer

    const granted = events.find((event) => event.type === 'turn.granted')
    expect(granted?.payload.grant.personaId).toBe('persona-1')
    expect(granted?.payload.grant.expiresAt).toBe(new Date(60_000).toISOString())
  })

  it('treats an interrupt raised while the abort promise is being created', async () => {
    const model = scriptedModel({ chunks: ['one', 'two'] })
    const harness = openSession(model)
    let interrupted = false

    harness.onEvent((event) => {
      if (event.type === 'persona.response.started' && !interrupted) {
        interrupted = true
        void harness.driver.interrupt()
      }
    })

    await harness.driver.send('go')
    const events = await runToEnd(harness)
    expect(
      events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({ reason: 'interrupted' })
  })

  it('collapses whitespace and bounds a short provider failure', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'whitespace-error',
      complete() {
        throw new Error('  alpha\n\t beta   gamma  ')
      },
    }
    const harness = openSession(model)
    await harness.driver.send('go')
    const events = await runToEnd(harness)
    const detail = (
      events.find((event) => event.type === 'persona.response.cancelled')?.payload as {
        detail?: string
      }
    ).detail
    expect(detail).toBe('Error: alpha beta gamma')
  })

  it('interrupts an in-flight reply when a second send starts directly', async () => {
    const gate = Promise.withResolvers<void>()
    let started: () => void = () => undefined
    const model: TextModelPort = {
      kind: 'canned',
      label: 'gated',
      async *complete(_request, options) {
        started()
        await gate.promise
        if (options?.signal?.aborted === true) return
        yield { text: 'late', done: true }
      },
    }
    const harness = openSession(model)
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve
    })

    const first = harness.driver.send('first')
    await firstStarted
    const second = harness.driver.send('second')
    gate.resolve()
    await Promise.all([first, second])
    const events = await runToEnd(harness)

    expect(events.filter((event) => event.type === 'persona.response.cancelled')).toHaveLength(1)
    expect(
      events.find((event) => event.type === 'persona.response.committed')?.payload,
    ).toMatchObject({ text: 'late' })
  })

  it('interrupts immediately when the provider aborts during complete()', async () => {
    const harnessRef: { driver?: SessionDriver } = {}
    const model: TextModelPort = {
      kind: 'canned',
      label: 'abort-during-complete',
      complete() {
        void harnessRef.driver?.interrupt()
        return (async function* () {
          yield { text: 'never', done: true }
        })()
      },
    }
    const harness = openSession(model)
    harnessRef.driver = harness.driver

    await harness.driver.send('go')
    const events = await runToEnd(harness)

    expect(
      events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({ reason: 'interrupted' })
    expect(events.some((event) => event.type === 'persona.response.committed')).toBe(false)
  })

  it('omits locale metadata unless a locale is configured', async () => {
    const without = scriptedModel({ chunks: ['ok'] })
    const plain = openSession(without)
    await plain.driver.send('one')
    await runToEnd(plain)
    expect(without.requests[0]?.metadata).toStrictEqual({ lang: 'en' })
    expect(without.requests[0]?.metadata).not.toHaveProperty('locale')

    const withLocale = scriptedModel({ chunks: ['ok'] })
    const localised = openSession(withLocale, { locale: 'en-GB' })
    await localised.driver.send('one')
    await runToEnd(localised)
    expect(withLocale.requests[0]?.metadata).toStrictEqual({ lang: 'en', locale: 'en-GB' })
  })

  it('uses the exact start() misuse message', async () => {
    const harness = openSession(scriptedModel({ chunks: ['ok'] }))
    await harness.driver.start()
    await expect(harness.driver.start()).rejects.toMatchObject({
      name: 'SessionDriverError',
      message: 'start() only opens an empty session',
    })
    await runToEnd(harness)
  })

  it('omits partialText when a cancelled turn produced no text', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'immediate-failure',
      complete() {
        throw new Error('boom')
      },
    }
    const harness = openSession(model)
    await harness.driver.send('go')
    const events = await runToEnd(harness)
    const cancelled = events.find((event) => event.type === 'persona.response.cancelled')
    expect(cancelled?.payload).not.toHaveProperty('partialText')
  })

  it('omits detail on a timeout that has no failure detail', async () => {
    const model: TextModelPort = {
      kind: 'canned',
      label: 'silent',
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
    const harness = openSession(model, { grantTtlMs: 1 })
    await harness.driver.send('go')
    const events = await runToEnd(harness)
    const cancelled = events.find((event) => event.type === 'persona.response.cancelled')
    expect(cancelled?.payload).toMatchObject({ reason: 'timeout' })
    expect(cancelled?.payload).not.toHaveProperty('detail')
    expect(cancelled?.payload).not.toHaveProperty('partialText')
  })

  it('rejects a send that was closed while its interrupt was in flight', async () => {
    let releaseReturn: () => void = () => undefined
    const returnGate = new Promise<void>((resolve) => {
      releaseReturn = resolve
    })
    let chunkSeen: () => void = () => undefined
    const sawChunk = new Promise<void>((resolve) => {
      chunkSeen = resolve
    })
    const model: TextModelPort = {
      kind: 'canned',
      label: 'blocking-close',
      async *complete() {
        yield { text: 'one', done: false }
        await new Promise(() => undefined)
      },
      // Only used when the driver closes the iterator after an interrupt.
      // It is attached below because ports are plain objects.
    }
    const iteratorPort: TextModelPort = {
      ...model,
      complete(request) {
        const inner = model.complete(request)
        return {
          [Symbol.asyncIterator]() {
            const iterator = inner[Symbol.asyncIterator]()
            return {
              next: () => iterator.next(),
              async return() {
                await returnGate
                return { done: true, value: undefined }
              },
            }
          },
        }
      },
    }
    const harness = openSession(iteratorPort)
    harness.onEvent((event) => {
      if (event.type === 'persona.response.chunk') chunkSeen()
    })

    const first = harness.driver.send('first')
    await sawChunk
    const second = harness.driver.send('second')
    const closing = harness.driver.close()
    releaseReturn()
    await expect(second).rejects.toMatchObject({ name: 'SessionClosedError' })
    await first
    await closing
    await harness.finished()
  })
})

describe('AsyncEventQueue terminal idempotency', () => {
  it('closes and fails idempotently', async () => {
    const closed = new AsyncEventQueue<number>()
    closed.close()
    closed.close()
    closed.fail(new Error('too late'))
    await expect(closed.next()).resolves.toEqual({ value: undefined, done: true })

    const failed = new AsyncEventQueue<number>()
    const error = new Error('first failure')
    failed.fail(error)
    failed.fail(new Error('second failure'))
    failed.close()
    await expect(failed.next()).rejects.toBe(error)
  })

  it('names the queue bound in its failure message', async () => {
    const queue = new AsyncEventQueue<number>(1)
    queue.push(1)
    queue.push(2)
    await expect(queue.next()).resolves.toEqual({ value: 1, done: false })
    await expect(queue.next()).rejects.toThrow(
      'event queue exceeded 1 undelivered events; the consumer is not keeping up',
    )
  })
})
