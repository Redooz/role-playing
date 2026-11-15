import { FakeClock } from '@rp/shared'
import {
  createTextSessionDriver,
  guardTurnEvents,
  type SessionEvent,
  type TextModelPort,
} from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import {
  createCannedProvider,
  type CompletionProvider,
  type CompletionRequest,
} from './canned-provider.js'
import { createCompletionProviderTextModel } from './text-model.adapter.js'

const recordedRequest: CompletionRequest = {
  provider: 'persona',
  model: 'canned/persona-v1',
  messages: [{ role: 'user', content: 'hello' }],
  metadata: { taskId: 'task-1', lang: 'en' },
}

async function collect(
  driver: ReturnType<typeof createTextSessionDriver>,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = []
  for await (const event of driver.events) events.push(event)
  return events
}

describe('CompletionProvider → TextModelPort adapter', () => {
  it('replays recorded output through the session driver', async () => {
    const provider = createCannedProvider([
      { request: recordedRequest, chunks: ['Hello ', 'there'] },
    ])
    const model = createCompletionProviderTextModel({
      provider,
      metadata: { taskId: 'task-1' },
    })

    const driver = createTextSessionDriver({
      sessionId: 'session-1',
      lang: 'en',
      clock: new FakeClock(0),
      model,
    })
    const events = collect(driver)

    await driver.send('hello')
    await driver.close()
    const emitted = await events

    expect(emitted.find((event) => event.type === 'persona.response.committed')?.payload).toEqual({
      grantId: 'session-1-grant-1',
      text: 'Hello there',
    })
    expect(guardTurnEvents(emitted).ok).toBe(true)
  })

  it('sends the driver conversation and merged metadata to the provider', async () => {
    const requests: CompletionRequest[] = []
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'recording',
      async *complete(request) {
        requests.push(request)
        yield { text: 'ok', done: true }
      },
    }
    const model = createCompletionProviderTextModel({
      provider,
      providerName: 'persona',
      model: 'canned/persona-v1',
      metadata: { taskId: 'task-1', lang: 'fr' },
    })

    const driver = createTextSessionDriver({
      sessionId: 'session-1',
      lang: 'en',
      clock: new FakeClock(0),
      model,
    })
    const events = collect(driver)
    await driver.send('bonjour')
    await driver.close()
    await events

    expect(requests).toHaveLength(1)
    expect(requests[0]?.messages).toEqual([{ role: 'user', content: 'bonjour' }])
    // The request's own labels win on a clash, so the driver's language is kept.
    expect(requests[0]?.metadata).toEqual({ taskId: 'task-1', lang: 'en' })
  })

  it('stops yielding as soon as the driver aborts', async () => {
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'two-chunks',
      async *complete() {
        yield { text: 'a', done: false }
        yield { text: 'b', done: true }
      },
    }
    const model = createCompletionProviderTextModel({ provider })
    const controller = new AbortController()
    const received: string[] = []

    for await (const chunk of model.complete(
      { messages: [{ role: 'user', content: 'go' }] },
      { signal: controller.signal },
    )) {
      received.push(chunk.text)
      controller.abort()
    }

    expect(received).toEqual(['a'])
  })

  it('uses the default provider and model labels with no metadata', async () => {
    const requests: CompletionRequest[] = []
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'recording',
      async *complete(request) {
        requests.push(request)
        yield { text: 'ok', done: true }
      },
    }
    const model = createCompletionProviderTextModel({ provider })

    for await (const _chunk of model.complete({
      messages: [{ role: 'assistant', content: 'hello' }],
    })) {
      // drain
    }

    expect(requests).toStrictEqual([
      {
        provider: 'persona',
        model: 'canned/persona-v1',
        messages: [{ role: 'assistant', content: 'hello' }],
      },
    ])
  })

  it('forwards provider metadata when the request has none', async () => {
    const requests: CompletionRequest[] = []
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'recording',
      async *complete(request) {
        requests.push(request)
        yield { text: 'ok', done: true }
      },
    }
    const model = createCompletionProviderTextModel({
      provider,
      metadata: { taskId: 'task-1' },
    })

    for await (const _chunk of model.complete({
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      // drain
    }

    expect(requests[0]?.metadata).toStrictEqual({ taskId: 'task-1' })
  })

  it('forwards request metadata when the adapter has none', async () => {
    const requests: CompletionRequest[] = []
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'recording',
      async *complete(request) {
        requests.push(request)
        yield { text: 'ok', done: true }
      },
    }
    const model = createCompletionProviderTextModel({ provider })

    for await (const _chunk of model.complete({
      messages: [{ role: 'user', content: 'hello' }],
      metadata: { lang: 'en' },
    })) {
      // drain
    }

    expect(requests[0]?.metadata).toStrictEqual({ lang: 'en' })
  })

  it('merges adapter metadata with the request labels winning a clash', async () => {
    const requests: CompletionRequest[] = []
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'recording',
      async *complete(request) {
        requests.push(request)
        yield { text: 'ok', done: true }
      },
    }
    const model = createCompletionProviderTextModel({
      provider,
      metadata: { taskId: 'task-1', lang: 'fr', locale: 'fr' },
    })

    for await (const _chunk of model.complete({
      messages: [{ role: 'user', content: 'hello' }],
      metadata: { lang: 'en', locale: 'en-GB' },
    })) {
      // drain
    }

    expect(requests[0]?.metadata).toStrictEqual({
      taskId: 'task-1',
      lang: 'en',
      locale: 'en-GB',
    })
  })

  it('passes the provider kind and label through the model port', () => {
    const provider: CompletionProvider = {
      kind: 'live',
      label: 'live-label',
      async *complete() {
        yield { text: '', done: true }
      },
    }
    const model: TextModelPort = createCompletionProviderTextModel({ provider })

    expect(model.kind).toBe('live')
    expect(model.label).toBe('live-label')
  })

  it('streams every provider chunk unchanged when no signal is supplied', async () => {
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'two-chunks',
      async *complete() {
        yield { text: 'a', done: false }
        yield { text: 'b', done: true }
      },
    }
    const model = createCompletionProviderTextModel({ provider })
    const received: Array<{ text: string; done: boolean }> = []

    for await (const chunk of model.complete({
      messages: [{ role: 'user', content: 'go' }],
    })) {
      received.push({ text: chunk.text, done: chunk.done })
    }

    expect(received).toStrictEqual([
      { text: 'a', done: false },
      { text: 'b', done: true },
    ])
  })

  it('yields nothing when the signal is already aborted', async () => {
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'two-chunks',
      async *complete() {
        yield { text: 'a', done: false }
        yield { text: 'b', done: true }
      },
    }
    const model = createCompletionProviderTextModel({ provider })
    const controller = new AbortController()
    controller.abort()
    const received: string[] = []

    for await (const chunk of model.complete(
      { messages: [{ role: 'user', content: 'go' }] },
      { signal: controller.signal },
    )) {
      received.push(chunk.text)
    }

    expect(received).toStrictEqual([])
  })

  it('forwards dispose to the provider exactly once', async () => {
    let disposed = 0
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'recording',
      async *complete() {
        yield { text: '', done: true }
      },
      dispose() {
        disposed += 1
      },
    }
    const model = createCompletionProviderTextModel({ provider })

    await model.dispose?.()

    expect(disposed).toBe(1)
  })

  it('keeps a dispose method that safely returns nothing for a provider without one', () => {
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'recording',
      async *complete() {
        yield { text: '', done: true }
      },
    }
    const model = createCompletionProviderTextModel({ provider })

    expect(model.dispose?.()).toBeUndefined()
  })

  it('turns a canned-provider miss into a provider failure, never fabricated output', async () => {
    const provider = createCannedProvider([])
    const model: TextModelPort = createCompletionProviderTextModel({ provider })
    const driver = createTextSessionDriver({
      sessionId: 'session-1',
      lang: 'en',
      clock: new FakeClock(0),
      model,
    })
    const events = collect(driver)

    await driver.send('unrecorded')
    await driver.close()
    const emitted = await events

    const cancelled = emitted.find((event) => event.type === 'persona.response.cancelled')
    expect(cancelled?.payload).toMatchObject({
      grantId: 'session-1-grant-1',
      reason: 'provider_failure',
    })
    expect((cancelled?.payload as { detail?: string }).detail).toContain('CannedProviderMissError')
    expect(emitted.some((event) => event.type === 'persona.response.committed')).toBe(false)
    expect(guardTurnEvents(emitted).ok).toBe(true)
  })
})
