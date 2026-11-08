import type { TextModelChunk } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_PROBE_MODEL,
  OpenRouterTextModelError,
  createOpenRouterTextModel,
  openRouterModelLabel,
  type OpenRouterRequestTiming,
} from './openrouter-text.adapter.js'

const API_KEY = 'test-openrouter-key-not-a-secret'
const MODEL = OPENROUTER_PROBE_MODEL

function sseResponse(events: readonly string[]): Response {
  return new Response(`${events.map((event) => `data: ${event}`).join('\n')}\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collect(
  model: ReturnType<typeof createOpenRouterTextModel>,
  signal?: AbortSignal,
): Promise<TextModelChunk[]> {
  const chunks: TextModelChunk[] = []
  for await (const chunk of model.complete(
    { messages: [{ role: 'user', content: 'hello' }] },
    signal === undefined ? undefined : { signal },
  )) {
    chunks.push(chunk)
  }
  return chunks
}

describe('OpenRouter text adapter', () => {
  it('streams plain text and carries usage from the final OpenAI-compatible chunk', async () => {
    const model = createOpenRouterTextModel({
      apiKey: API_KEY,
      model: MODEL,
      fetchImpl: async () =>
        sseResponse([
          '{"choices":[{"delta":{"content":"Bonjour "}}]}',
          '{"choices":[{"delta":{"content":"Nico"}}]}',
          '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":3}}',
          '[DONE]',
        ]),
    })

    expect(model.kind).toBe('live')
    expect(model.label).toBe(openRouterModelLabel(MODEL))
    expect(await collect(model)).toEqual([
      { text: 'Bonjour ', done: false },
      { text: 'Nico', done: false },
      { text: '', done: true, usage: { inputTokens: 9, outputTokens: 3 } },
    ])
  })

  it('posts the requested model in streaming mode with the OpenRouter header', async () => {
    let url = ''
    let init: RequestInit | undefined

    const model = createOpenRouterTextModel({
      apiKey: API_KEY,
      model: MODEL,
      appName: 'role-playing-bench',
      fetchImpl: async (requestUrl, requestInit) => {
        url = String(requestUrl)
        init = requestInit
        return sseResponse(['[DONE]'])
      },
    })
    await collect(model)

    expect(url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`)
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`)
    expect(headers['X-Title']).toBe('role-playing-bench')

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body['model']).toBe(MODEL)
    expect(body['stream']).toBe(true)
    expect(body['messages']).toEqual([{ role: 'user', content: 'hello' }])
    expect(body).not.toHaveProperty('response_format')
  })

  it('turns a non-2xx response into an error that does not leak the key', async () => {
    const model = createOpenRouterTextModel({
      apiKey: API_KEY,
      model: MODEL,
      fetchImpl: async () => new Response('no credit', { status: 402 }),
    })

    await expect(collect(model)).rejects.toMatchObject({
      name: 'OpenRouterTextModelError',
      status: 402,
    })
    try {
      await collect(model)
    } catch (error) {
      expect((error as Error).message).not.toContain(API_KEY)
    }
  })

  it('rejects a stream without [DONE]', async () => {
    const model = createOpenRouterTextModel({
      apiKey: API_KEY,
      model: MODEL,
      fetchImpl: async () => sseResponse(['{"choices":[{"delta":{"content":"partial"}}]}']),
    })

    await expect(collect(model)).rejects.toBeInstanceOf(OpenRouterTextModelError)
  })

  it('reports request timing boundaries', async () => {
    const times = [0, 10, 20, 30]
    let index = 0
    const timings: OpenRouterRequestTiming[] = []

    const model = createOpenRouterTextModel({
      apiKey: API_KEY,
      model: MODEL,
      now: () => times[index++] ?? 99,
      fetchImpl: async () => sseResponse(['{"choices":[{"delta":{"content":"hello"}}]}', '[DONE]']),
      onTiming: (timing) => timings.push(timing),
    })

    await collect(model)

    expect(timings).toEqual([
      {
        requestStartedAt: 0,
        responseHeadersAt: 10,
        firstContentAt: 20,
        finishedAt: 30,
        ok: true,
        status: 200,
      },
    ])
  })

  it('refuses to start without a key or a model', () => {
    expect(() => createOpenRouterTextModel({ apiKey: '  ', model: MODEL })).toThrow(
      OpenRouterTextModelError,
    )
    expect(() => createOpenRouterTextModel({ apiKey: API_KEY, model: ' ' })).toThrow(
      OpenRouterTextModelError,
    )
  })
})
