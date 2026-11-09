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
  it('pins the base URL, probe model and label format', () => {
    expect(OPENROUTER_BASE_URL).toBe('https://openrouter.ai/api/v1')
    expect(OPENROUTER_PROBE_MODEL).toBe('google/gemma-4-31b-it')
    expect(openRouterModelLabel('google/gemma-4-31b-it')).toBe('openrouter/google/gemma-4-31b-it')
  })

  it('keeps a cause and status on its typed error', () => {
    const cause = new Error('underlying')
    const withCause = new OpenRouterTextModelError('wrapped', { cause, status: 402 })
    expect(withCause.name).toBe('OpenRouterTextModelError')
    expect(withCause.status).toBe(402)
    expect(withCause.cause).toBe(cause)
    const withoutCause = new OpenRouterTextModelError('plain')
    expect(withoutCause.cause).toBeUndefined()
    expect('cause' in withoutCause).toBe(false)
  })

  it('uses the default attribution title', async () => {
    let headers: Record<string, string> = {}
    const model = createOpenRouterTextModel({
      apiKey: API_KEY,
      model: MODEL,
      fetchImpl: async (_url, init) => {
        headers = init?.headers as Record<string, string>
        return sseResponse(['[DONE]'])
      },
    })
    await collect(model)
    expect(headers['X-Title']).toBe('role-playing')
  })

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
    expect(body['temperature']).toBe(0.6)
    expect(body['top_p']).toBe(0.95)
    expect(body['max_completion_tokens']).toBe(2048)
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('include_reasoning')
  })

  it('accepts an explicit generation profile', async () => {
    let init: RequestInit | undefined
    const model = createOpenRouterTextModel({
      apiKey: API_KEY,
      model: MODEL,
      generation: { temperature: 0.2, maxCompletionTokens: 64, includeReasoning: true },
      fetchImpl: async (_url, requestInit) => {
        init = requestInit
        return sseResponse(['[DONE]'])
      },
    })
    await collect(model)

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body['temperature']).toBe(0.2)
    expect(body['max_completion_tokens']).toBe(64)
    expect(body['include_reasoning']).toBe(true)
    expect(body).not.toHaveProperty('top_p')
    expect(body).not.toHaveProperty('reasoning_effort')
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
    await expect(collect(model)).rejects.toThrow('OpenRouter request failed with HTTP 402')
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
    expect(() => createOpenRouterTextModel({ apiKey: '  ', model: MODEL })).toThrow(
      'OPENROUTER_API_KEY is empty; the adapter cannot start',
    )
    expect(() => createOpenRouterTextModel({ apiKey: API_KEY, model: ' ' })).toThrow(
      OpenRouterTextModelError,
    )
    expect(() => createOpenRouterTextModel({ apiKey: API_KEY, model: ' ' })).toThrow(
      'an OpenRouter model id is required',
    )
  })

  it('wraps a pre-response fetch failure with a cause', async () => {
    const cause = new Error('network down')
    const model = createOpenRouterTextModel({
      apiKey: API_KEY,
      model: MODEL,
      fetchImpl: async () => {
        throw cause
      },
    })
    try {
      await collect(model)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(OpenRouterTextModelError)
      expect((error as Error).message).toBe(
        'OpenRouter request failed before a response was received',
      )
      expect((error as Error & { cause?: unknown }).cause).toBe(cause)
    }
  })
})
