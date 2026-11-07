import { describe, expect, it } from 'vitest'
import {
  GROQ_BASE_URL,
  GROQ_PERSONA_MODEL,
  GROQ_TEXT_MODEL_LABEL,
  GroqTextModelError,
  createGroqTextModel,
} from './groq-text.adapter.js'
import type { TextModelChunk } from '@rp/session-core'

const API_KEY = 'test-key-not-a-secret'

function sseResponse(events: readonly string[]): Response {
  return new Response(`${events.map((event) => `data: ${event}`).join('\n')}\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collect(
  model: ReturnType<typeof createGroqTextModel>,
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

describe('Groq text adapter', () => {
  it('streams plain text chunks and a final chunk with usage', async () => {
    const model = createGroqTextModel({
      apiKey: API_KEY,
      fetchImpl: async () =>
        sseResponse([
          '{"choices":[{"delta":{"content":"Hello "}}]}',
          '{"choices":[{"delta":{"content":"there"}}]}',
          '{"choices":[{"delta":{},"finish_reason":"stop"}],"x_groq":{"usage":{"prompt_tokens":5,"completion_tokens":2}}}',
          '[DONE]',
        ]),
    })

    expect(model.kind).toBe('live')
    expect(model.label).toBe(GROQ_TEXT_MODEL_LABEL)
    expect(await collect(model)).toEqual([
      { text: 'Hello ', done: false },
      { text: 'there', done: false },
      { text: '', done: true, usage: { inputTokens: 5, outputTokens: 2 } },
    ])
  })

  it('posts the fixed model in streaming mode with no JSON response format', async () => {
    let url = ''
    let init: RequestInit | undefined

    const model = createGroqTextModel({
      apiKey: API_KEY,
      fetchImpl: async (requestUrl, requestInit) => {
        url = String(requestUrl)
        init = requestInit
        return sseResponse(['[DONE]'])
      },
    })
    await collect(model)

    expect(url).toBe(`${GROQ_BASE_URL}/chat/completions`)
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${API_KEY}`)

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body['model']).toBe(GROQ_PERSONA_MODEL)
    expect(body['stream']).toBe(true)
    expect(body['messages']).toEqual([{ role: 'user', content: 'hello' }])
    expect(body).not.toHaveProperty('response_format')
  })

  it('turns a non-2xx response into an error that does not leak the key', async () => {
    const model = createGroqTextModel({
      apiKey: API_KEY,
      fetchImpl: async () => new Response('rate limited', { status: 429 }),
    })

    await expect(collect(model)).rejects.toMatchObject({
      name: 'GroqTextModelError',
      status: 429,
    })
    try {
      await collect(model)
    } catch (error) {
      expect((error as Error).message).not.toContain(API_KEY)
    }
  })

  it('rejects a stream that ends without [DONE]', async () => {
    const model = createGroqTextModel({
      apiKey: API_KEY,
      fetchImpl: async () => sseResponse(['{"choices":[{"delta":{"content":"partial"}}]}']),
    })

    await expect(collect(model)).rejects.toBeInstanceOf(GroqTextModelError)
  })

  it('rejects a malformed data line instead of skipping it', async () => {
    const model = createGroqTextModel({
      apiKey: API_KEY,
      fetchImpl: async () => sseResponse(['{"choices":', '[DONE]']),
    })

    await expect(collect(model)).rejects.toThrow(/malformed/)
  })

  it('passes the abort signal to fetch and stops yielding once aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let seen: AbortSignal | null | undefined

    const model = createGroqTextModel({
      apiKey: API_KEY,
      fetchImpl: async (_url, init) => {
        seen = init?.signal
        return sseResponse(['{"choices":[{"delta":{"content":"should not arrive"}}]}', '[DONE]'])
      },
    })

    expect(await collect(model, controller.signal)).toEqual([])
    expect(seen).toBe(controller.signal)
  })

  it('refuses to start without an API key', () => {
    expect(() => createGroqTextModel({ apiKey: '  ' })).toThrow(GroqTextModelError)
  })
})
