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

    expect(emitted.find((event) => event.type === 'persona.response.cancelled')?.payload).toEqual({
      grantId: 'session-1-grant-1',
      reason: 'provider_failure',
    })
    expect(emitted.some((event) => event.type === 'persona.response.committed')).toBe(false)
    expect(guardTurnEvents(emitted).ok).toBe(true)
  })
})
