import { FakeClock } from '@rp/shared'
import { describe, expect, it } from 'vitest'
import type { ConversationMessage, PersonaSession, SessionArbiterInput } from './arbiter-port.js'
import type { EventPayloadFor, SessionEventName } from './events.js'
import { streamGrant, type GrantStreamHost } from './grant-stream.js'
import type { TextModelChunk, TextModelPort, TextModelRequest } from './model-port.js'

/**
 * Direct contract for one grant's stream.
 *
 * The driver tests prove the seam; this suite pins every branch of the stream
 * itself: instruction selection, chunk and partial ordering, every failure
 * shape, the wall deadline and the simulated deadline, and the close bound.
 */

interface Recorded {
  readonly type: SessionEventName
  readonly payload: unknown
}

interface HostHarness {
  readonly host: GrantStreamHost<string>
  readonly events: Recorded[]
  readonly inputs: SessionArbiterInput<string>[]
  readonly clock: FakeClock
  interjections(): number
}

function makeHost(
  options: {
    readonly clock?: FakeClock
    readonly locale?: string
    readonly history?: readonly ConversationMessage[]
    readonly onReduce?: (input: SessionArbiterInput<string>) => void
  } = {},
): HostHarness {
  const clock = options.clock ?? new FakeClock(0)
  const events: Recorded[] = []
  const inputs: SessionArbiterInput<string>[] = []
  let interjections = 0

  return {
    clock,
    events,
    inputs,
    interjections: () => interjections,
    host: {
      clock,
      lang: 'en',
      locale: options.locale,
      history: options.history ?? [],
      emit<Name extends SessionEventName>(type: Name, payload: EventPayloadFor<Name>) {
        events.push({ type, payload })
      },
      async reduce(input) {
        inputs.push(input)
        options.onReduce?.(input)
      },
      async collectInterjections() {
        interjections += 1
      },
    },
  }
}

interface ModelOptions {
  readonly beforeChunk?: (index: number) => void | Promise<void>
  readonly failAfter?: number
  readonly endWithoutDone?: boolean
  readonly chunkAfterDone?: boolean
  readonly nonStringChunk?: boolean
  readonly delayMs?: number
}

function model(
  chunks: readonly TextModelChunk[],
  options: ModelOptions = {},
): TextModelPort & { readonly requests: TextModelRequest[]; renders: number } {
  const requests: TextModelRequest[] = []
  const signals: (AbortSignal | undefined)[] = []
  const result = {
    kind: 'canned' as const,
    label: 'scripted',
    requests,
    signals,
    renders: 0,
    async *complete(
      request: TextModelRequest,
      completeOptions?: { signal?: AbortSignal },
    ): AsyncIterable<TextModelChunk> {
      requests.push(request)
      signals.push(completeOptions?.signal)
      result.renders += 1
      for (const [index, chunk] of chunks.entries()) {
        await options.beforeChunk?.(index)
        if (options.failAfter === index) throw new Error('provider failed')
        if (options.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs))
        }
        await Promise.resolve()
        if (options.nonStringChunk === true && index === 0) {
          yield { text: 1, done: false } as unknown as TextModelChunk
          continue
        }
        const done = index === chunks.length - 1 && options.endWithoutDone !== true
        yield { ...chunk, done }
      }
      if (options.chunkAfterDone === true) {
        await Promise.resolve()
        yield { text: 'late', done: true }
      }
    },
  }
  return result
}

function session(
  chunksOrPersona: TextModelPort | readonly TextModelChunk[],
  overrides: Partial<PersonaSession> = {},
): PersonaSession {
  const personaModel = Array.isArray(chunksOrPersona)
    ? model(chunksOrPersona)
    : (chunksOrPersona as TextModelPort)
  return { personaId: 'manager', model: personaModel, ...overrides }
}

function run(
  host: HostHarness,
  persona: PersonaSession,
  overrides: Partial<Parameters<typeof streamGrant>[0]> = {},
) {
  const controller = new AbortController()
  return {
    controller,
    result: streamGrant(
      {
        grantId: 'grant-1',
        personaId: 'manager',
        turnId: 'turn-1',
        expiresAtMs: host.clock.now() + 60_000,
        greeting: false,
        tracked: true,
        controller,
        cancellationReason: () => 'revoked',
        ...overrides,
      },
      persona,
      host.host,
    ),
  }
}

function chunk(text: string, extra: Partial<TextModelChunk> = {}): TextModelChunk {
  return { text, done: false, ...extra }
}

/** A hand-written iterator so the close hook can throw or be absent. */
function manualPersona(withReturn: boolean): PersonaSession {
  return {
    personaId: 'manager',
    model: {
      kind: 'canned',
      label: 'manual',
      complete() {
        let step = 0
        const iterator: AsyncIterator<TextModelChunk> = {
          async next() {
            step += 1
            return step === 1
              ? { value: chunk('done', { done: true }), done: false as const }
              : { value: undefined, done: true as const }
          },
          ...(withReturn
            ? {
                async return() {
                  throw new Error('close failed')
                },
              }
            : {}),
        }
        return {
          [Symbol.asyncIterator]() {
            return iterator
          },
        }
      },
    },
  }
}

/** A model driven by one hand-written `next` per call. */
function manualModel(next: () => Promise<IteratorResult<TextModelChunk>>): TextModelPort {
  return {
    kind: 'canned',
    label: 'manual',
    complete() {
      const iterator: AsyncIterator<TextModelChunk> = { next }
      return {
        [Symbol.asyncIterator]() {
          return iterator
        },
      }
    },
  }
}

describe('grant stream', () => {
  it('emits started, one chunk and one partial per fragment, then a tick', async () => {
    const harness = makeHost()
    const { result } = run(harness, session([chunk('hello '), chunk('there')]))

    const outcome = await result

    expect(harness.events.map((event) => event.type)).toEqual([
      'persona.response.started',
      'persona.response.chunk',
      'persona.response.chunk',
    ])
    expect(harness.inputs.map((input) => input.kind)).toEqual([
      'partial',
      'tick',
      'partial',
      'tick',
    ])
    expect(harness.interjections()).toBe(2)
    expect(outcome).toMatchObject({ outcome: 'committed', text: 'hello there' })
  })

  it('prepends the greeting pack only on the greeting turn', async () => {
    const greeting = [{ role: 'system' as const, content: 'greeting pack' }]
    const instructions = [{ role: 'system' as const, content: 'full pack' }]
    const persona = session([chunk('hi')], { greetingInstructions: greeting, instructions })

    const greetingHarness = makeHost()
    await run(greetingHarness, persona, { greeting: true }).result
    expect(
      (persona.model as TextModelPort & { requests: TextModelRequest[] }).requests[0]?.messages,
    ).toEqual(greeting)

    const turnHarness = makeHost()
    await run(turnHarness, persona).result
    expect(
      (persona.model as TextModelPort & { requests: TextModelRequest[] }).requests[1]?.messages,
    ).toEqual(instructions)
  })

  it('falls back from missing greeting instructions to instructions and then to none', async () => {
    const instructions = [{ role: 'system' as const, content: 'full pack' }]
    const withInstructions = session([chunk('a')], { instructions })
    const first = makeHost()
    await run(first, withInstructions, { greeting: true }).result
    expect(
      (withInstructions.model as TextModelPort & { requests: TextModelRequest[] }).requests[0]
        ?.messages,
    ).toEqual(instructions)

    const empty = session([chunk('b')])
    const second = makeHost()
    await run(second, empty, { greeting: true }).result
    expect(
      (empty.model as TextModelPort & { requests: TextModelRequest[] }).requests[0]?.messages,
    ).toEqual([])
  })

  it('passes history, language, persona and locale to the model request', async () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer', personaId: 'manager' },
    ]
    const harness = makeHost({ locale: 'en-GB', history })
    const persona = session([chunk('ok')])

    await run(harness, persona).result

    const scripted = persona.model as TextModelPort & {
      requests: TextModelRequest[]
      signals: (AbortSignal | undefined)[]
    }
    expect(scripted.signals[0]).toBeInstanceOf(AbortSignal)
    const request = scripted.requests[0]
    expect(request).toMatchObject({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
      ],
      metadata: { lang: 'en', personaId: 'manager', locale: 'en-GB' },
      requestId: 'turn-1',
    })
  })

  it('omits the locale when the session has none', async () => {
    const harness = makeHost()
    const persona = session([chunk('ok')])

    await run(harness, persona).result

    const request = (persona.model as TextModelPort & { requests: TextModelRequest[] }).requests[0]
    expect(request?.metadata).toStrictEqual({ lang: 'en', personaId: 'manager' })
  })

  it('does not feed the arbiter or ask for interjections when untracked', async () => {
    const harness = makeHost()
    const { result } = run(harness, session([chunk('greeting')]), {
      tracked: false,
      greeting: true,
    })

    const outcome = await result

    expect(outcome.outcome).toBe('committed')
    expect(harness.inputs).toEqual([])
    expect(harness.interjections()).toBe(0)
  })

  it('returns usage from the last chunk and omits it when unreported', async () => {
    const harness = makeHost()
    const withUsage = await run(
      harness,
      session([chunk('done', { usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.01 } })]),
    ).result
    expect(withUsage.usage).toEqual({ inputTokens: 3, outputTokens: 4, costUsd: 0.01 })

    const withoutUsage = await run(makeHost(), session([chunk('done')])).result
    expect(withoutUsage).toStrictEqual({
      outcome: 'committed',
      text: 'done',
      cancellationReason: 'revoked',
    })
  })

  it('ignores an empty chunk but keeps the sequence for real text', async () => {
    const harness = makeHost()
    const { result } = run(harness, session([chunk(''), chunk('text')]))

    await result

    expect(harness.events.filter((event) => event.type === 'persona.response.chunk')).toHaveLength(
      1,
    )
    expect(harness.inputs.find((input) => input.kind === 'partial')).toMatchObject({ sequence: 0 })
  })

  it('fails on a non-string chunk', async () => {
    const harness = makeHost()
    const outcome = await run(harness, session([chunk('x')], {})).result
    expect(outcome.outcome).toBe('committed')

    const bad = makeHost()
    const badOutcome = await run(bad, session(model([chunk('x')], { nonStringChunk: true }))).result
    expect(badOutcome).toMatchObject({
      outcome: 'failed',
      detail: 'provider yielded a non-string chunk',
      cancellationReason: 'provider_failure',
    })
  })

  it('fails on a chunk after the final chunk', async () => {
    const harness = makeHost()
    const outcome = await run(harness, session(model([chunk('done')], { chunkAfterDone: true })))
      .result

    expect(outcome).toMatchObject({
      outcome: 'failed',
      detail: 'provider yielded a chunk after the final chunk',
    })
  })

  it('fails when the stream ends without a final chunk', async () => {
    const harness = makeHost()
    const outcome = await run(harness, session(model([chunk('half')], { endWithoutDone: true })))
      .result

    expect(outcome).toMatchObject({
      outcome: 'failed',
      detail: 'stream ended without a final chunk',
    })
  })

  it('reports a provider error as a failure, and an aborted error as a cancel', async () => {
    const harness = makeHost()
    const failed = await run(harness, session(model([chunk('x')], { failAfter: 0 }))).result
    expect(failed).toMatchObject({
      outcome: 'failed',
      cancellationReason: 'provider_failure',
    })
    expect(failed.detail).toContain('provider failed')

    const abortedHarness = makeHost()
    const controller = new AbortController()
    controller.abort()
    const cancelled = await streamGrant(
      {
        grantId: 'grant-1',
        personaId: 'manager',
        turnId: 'turn-1',
        expiresAtMs: 60_000,
        greeting: false,
        tracked: true,
        controller,
        cancellationReason: () => 'user_barge_in',
      },
      session(model([chunk('x')], { failAfter: 0 })),
      abortedHarness.host,
    )
    expect(cancelled.outcome).toBe('cancelled')
    expect(cancelled.cancellationReason).toBe('user_barge_in')
  })

  it('cancels when the controller aborts mid-stream', async () => {
    const harness = makeHost()
    const controller = new AbortController()
    const persona = session(
      model([chunk('one'), chunk('two')], {
        beforeChunk(index) {
          if (index === 1) controller.abort()
        },
      }),
    )

    const outcome = await streamGrant(
      {
        grantId: 'grant-1',
        personaId: 'manager',
        turnId: 'turn-1',
        expiresAtMs: 60_000,
        greeting: false,
        tracked: true,
        controller,
        cancellationReason: () => 'interrupted',
      },
      persona,
      harness.host,
    )

    expect(outcome.outcome).toBe('cancelled')
    expect(outcome.cancellationReason).toBe('interrupted')
    expect(outcome.text).toBe('one')
  })

  it('stops at the simulated grant deadline and ticks at the deadline', async () => {
    const clock = new FakeClock(0)
    const harness = makeHost({ clock })
    const persona = session(
      model([chunk('one'), chunk('two')], {
        beforeChunk(index) {
          if (index === 1) clock.advance(60_000)
        },
      }),
    )

    const outcome = await run(harness, persona).result

    expect(outcome.outcome).toBe('cancelled')
    expect(harness.inputs).toContainEqual({ kind: 'tick', nowMs: 60_000 })
  })

  it('stops at the wall deadline even when the provider is silent', async () => {
    const clock = new FakeClock(1_000)
    const harness = makeHost({ clock })
    const persona = session(model([chunk('late')], { delayMs: 20 }))

    const outcome = await run(harness, persona, { expiresAtMs: clock.now() + 5 }).result

    expect(outcome.outcome).toBe('cancelled')
    expect(harness.inputs).toContainEqual({ kind: 'tick', nowMs: 1_005 })
  })

  it('posts no tick and still aborts an untracked deadline', async () => {
    const clock = new FakeClock(0)
    const harness = makeHost({ clock })
    const controller = new AbortController()
    const persona = session(model([chunk('late')], { delayMs: 20 }))

    const outcome = await streamGrant(
      {
        grantId: 'grant-1',
        personaId: 'manager',
        turnId: 'turn-1',
        expiresAtMs: 5,
        greeting: true,
        tracked: false,
        controller,
        cancellationReason: () => 'revoked',
      },
      persona,
      harness.host,
    )

    expect(outcome.outcome).toBe('cancelled')
    expect(harness.inputs).toEqual([])
    expect(controller.signal.aborted).toBe(true)
  })

  it('closes the iterator even when its return throws', async () => {
    const harness = makeHost()
    const outcome = await run(harness, manualPersona(true)).result

    expect(outcome.outcome).toBe('committed')
  })

  it('does not fail when the iterator has no return hook', async () => {
    const harness = makeHost()
    const outcome = await run(harness, manualPersona(false)).result

    expect(outcome.outcome).toBe('committed')
  })

  it('turns a completed stream into a cancel when the abort lands on the last chunk', async () => {
    const harness = makeHost()
    const controller = new AbortController()
    const persona = session([chunk('done')])
    const host: GrantStreamHost<string> = {
      ...harness.host,
      emit(type, payload) {
        harness.host.emit(type, payload)
        if (type === 'persona.response.chunk') controller.abort()
      },
    }

    const outcome = await streamGrant(
      {
        grantId: 'grant-1',
        personaId: 'manager',
        turnId: 'turn-1',
        expiresAtMs: 60_000,
        greeting: false,
        tracked: true,
        controller,
        cancellationReason: () => 'revoked',
      },
      persona,
      host,
    )

    expect(outcome.outcome).toBe('cancelled')
  })

  it('cancels when the controller aborts while the provider is pending', async () => {
    const harness = makeHost()
    const controller = new AbortController()
    const persona: PersonaSession = {
      personaId: 'manager',
      model: manualModel(() => new Promise(() => undefined)),
    }

    setTimeout(() => controller.abort(), 5)
    const outcome = await streamGrant(
      {
        grantId: 'grant-1',
        personaId: 'manager',
        turnId: 'turn-1',
        expiresAtMs: 60_000,
        greeting: false,
        tracked: true,
        controller,
        cancellationReason: () => 'user_barge_in',
      },
      persona,
      harness.host,
    )

    expect(outcome.outcome).toBe('cancelled')
    expect(outcome.cancellationReason).toBe('user_barge_in')
  })

  it('drops a chunk produced just after an abort', async () => {
    const harness = makeHost()
    const controller = new AbortController()
    let step = 0
    const persona: PersonaSession = {
      personaId: 'manager',
      model: manualModel(() => {
        step += 1
        const result =
          step === 1
            ? { value: chunk('dropped'), done: false as const }
            : { value: undefined, done: true as const }
        queueMicrotask(() => controller.abort())
        return Promise.resolve(result)
      }),
    }

    const outcome = await streamGrant(
      {
        grantId: 'grant-1',
        personaId: 'manager',
        turnId: 'turn-1',
        expiresAtMs: 60_000,
        greeting: false,
        tracked: true,
        controller,
        cancellationReason: () => 'revoked',
      },
      persona,
      harness.host,
    )

    expect(outcome.outcome).toBe('cancelled')
    expect(harness.events.map((event) => event.type)).toEqual(['persona.response.started'])
  })

  it('treats a provider error after an abort as a cancel', async () => {
    const harness = makeHost()
    const controller = new AbortController()
    const persona: PersonaSession = {
      personaId: 'manager',
      model: manualModel(async () => {
        controller.abort()
        throw new Error('provider failed after abort')
      }),
    }

    const outcome = await streamGrant(
      {
        grantId: 'grant-1',
        personaId: 'manager',
        turnId: 'turn-1',
        expiresAtMs: 60_000,
        greeting: false,
        tracked: true,
        controller,
        cancellationReason: () => 'user_barge_in',
      },
      persona,
      harness.host,
    )

    expect(outcome.outcome).toBe('cancelled')
    expect(outcome.detail).toBeUndefined()
  })

  it('emits no chunk events for an abort before the first chunk', async () => {
    const harness = makeHost()
    const controller = new AbortController()
    controller.abort()

    const outcome = await streamGrant(
      {
        grantId: 'grant-1',
        personaId: 'manager',
        turnId: 'turn-1',
        expiresAtMs: 60_000,
        greeting: false,
        tracked: true,
        controller,
        cancellationReason: () => 'user_barge_in',
      },
      session([chunk('never')]),
      harness.host,
    )

    expect(outcome).toMatchObject({ outcome: 'cancelled', text: '' })
    expect(harness.events.map((event) => event.type)).toEqual(['persona.response.started'])
  })
})
