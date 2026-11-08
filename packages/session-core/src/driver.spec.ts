import { FakeClock, createSeededRandom } from '@rp/shared'
import { describe, expect, it } from 'vitest'
import {
  createTextSessionDriver,
  guardTurnEvents,
  type SessionEvent,
  type SessionDriver,
  type TextModelChunk,
  type TextModelPort,
  type TextModelRequest,
  type TextModelUsage,
} from './index.js'
import { SessionClosedError, SessionDriverError } from './driver.js'

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
  options: { grantTtlMs?: number; clock?: FakeClock } = {},
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
    expect(model.requests[1]?.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'One' },
      { role: 'user', content: 'second' },
    ])
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
    ).toMatchObject({ reason: 'provider_failure' })
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
    expect(cancelled?.payload).toEqual({
      grantId: 'session-1-grant-1',
      reason: 'provider_failure',
      partialText: 'partial ',
    })
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
    ).toMatchObject({ reason: 'provider_failure', partialText: 'partial' })
  })

  it('treats a chunk after the final chunk as a provider failure', async () => {
    const model = scriptedModel({ chunks: ['done'], chunkAfterDone: true })
    const harness = openSession(model)

    await harness.driver.send('go')
    await runToEnd(harness)

    expect(
      harness.events.find((event) => event.type === 'persona.response.cancelled')?.payload,
    ).toMatchObject({ reason: 'provider_failure' })
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
    ).toMatchObject({ reason: 'provider_failure' })
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
    await expect(harness.driver.send('after close')).rejects.toBeInstanceOf(SessionClosedError)
  })

  it('rejects an empty utterance without emitting a user event', async () => {
    const harness = openSession(scriptedModel({ chunks: ['One'] }))

    await expect(harness.driver.send('   ')).rejects.toBeInstanceOf(SessionDriverError)
    const events = await runToEnd(harness)

    expect(events.some((event) => event.type === 'user.utterance.committed')).toBe(false)
  })
})
