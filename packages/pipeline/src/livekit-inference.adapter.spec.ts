import { createHmac } from 'node:crypto'
import type { TextModelChunk } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import {
  LIVEKIT_GEMMA_MODEL,
  LIVEKIT_INFERENCE_DEFAULT_BASE_URL,
  LiveKitInferenceTextModelError,
  createLiveKitInferenceAccessToken,
  createLiveKitInferenceTextModel,
  liveKitModelLabel,
  type LiveKitInferenceRequestTiming,
} from './livekit-inference.adapter.js'

const API_KEY = 'test-livekit-key-not-a-secret'
const API_SECRET = 'test-livekit-secret-not-a-secret'
const MODEL = LIVEKIT_GEMMA_MODEL

function sseResponse(events: readonly string[]): Response {
  return new Response(`${events.map((event) => `data: ${event}`).join('\n')}\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collect(
  model: ReturnType<typeof createLiveKitInferenceTextModel>,
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

describe('LiveKit Inference access token', () => {
  it('mints an HS256 token with the inference grant and issuer', () => {
    const token = createLiveKitInferenceAccessToken({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      ttlSeconds: 600,
      nowSeconds: () => 1_000,
    })
    const [header, payload, signature] = token.split('.')
    expect(header).toBeDefined()
    expect(payload).toBeDefined()
    expect(signature).toBeDefined()

    const decodedHeader = JSON.parse(Buffer.from(header as string, 'base64url').toString()) as {
      alg: string
      typ: string
    }
    const decodedPayload = JSON.parse(Buffer.from(payload as string, 'base64url').toString()) as {
      inference: { perform: boolean }
      iss: string
      sub: string
      nbf: number
      exp: number
    }
    expect(decodedHeader).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(decodedPayload).toEqual({
      inference: { perform: true },
      iss: API_KEY,
      sub: 'agent',
      nbf: 0,
      exp: 1_600,
    })

    const expected = createHmac('sha256', API_SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url')
    expect(signature).toBe(expected)
  })

  it('refuses an empty key or secret', () => {
    expect(() => createLiveKitInferenceAccessToken({ apiKey: '', apiSecret: API_SECRET })).toThrow(
      LiveKitInferenceTextModelError,
    )
    expect(() => createLiveKitInferenceAccessToken({ apiKey: API_KEY, apiSecret: '' })).toThrow(
      LiveKitInferenceTextModelError,
    )
  })

  it('uses the fixed ten-minute default TTL', () => {
    const token = createLiveKitInferenceAccessToken({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      nowSeconds: () => 1_000,
    })
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] as string, 'base64url').toString(),
    ) as { exp: number }
    expect(payload.exp).toBe(1_600)
  })
})

describe('LiveKit Inference text adapter', () => {
  it('pins the Gemma model id and public label', () => {
    expect(LIVEKIT_GEMMA_MODEL).toBe('google/gemma-4-31b-it')
    expect(liveKitModelLabel(LIVEKIT_GEMMA_MODEL)).toBe('livekit/google/gemma-4-31b-it')
  })

  it('streams plain text and carries usage from the final chunk', async () => {
    const model = createLiveKitInferenceTextModel({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      model: MODEL,
      fetchImpl: async () =>
        sseResponse([
          '{"choices":[{"delta":{"content":"Bonjour "}}]}',
          '{"choices":[{"delta":{"content":"Nico"}}]}',
          '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
          '{"usage":{"prompt_tokens":9,"completion_tokens":3}}',
          '[DONE]',
        ]),
    })

    expect(model.kind).toBe('live')
    expect(model.label).toBe(liveKitModelLabel(MODEL))
    expect(await collect(model)).toEqual([
      { text: 'Bonjour ', done: false },
      { text: 'Nico', done: false },
      { text: '', done: true, usage: { inputTokens: 9, outputTokens: 3 } },
    ])
  })

  it('posts the model in streaming mode with a fresh bearer token and no reasoning', async () => {
    let url = ''
    let authorization = ''
    let body: Record<string, unknown> = {}
    const model = createLiveKitInferenceTextModel({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      model: MODEL,
      nowSeconds: () => 1_000,
      fetchImpl: async (requestUrl, init) => {
        url = String(requestUrl)
        authorization = String(
          (init?.headers as Record<string, string> | undefined)?.['Authorization'],
        )
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return sseResponse(['{"choices":[{"delta":{},"finish_reason":"stop"}]}', '[DONE]'])
      },
    })

    await collect(model)

    expect(url).toBe(`${LIVEKIT_INFERENCE_DEFAULT_BASE_URL}/chat/completions`)
    expect(authorization.startsWith('Bearer ')).toBe(true)
    expect(authorization).not.toContain(API_SECRET)
    expect(body['model']).toBe(MODEL)
    expect(body['stream']).toBe(true)
    expect(body['messages']).toEqual([{ role: 'user', content: 'hello' }])
    expect(body['temperature']).toBe(0.6)
    expect(body['top_p']).toBe(0.95)
    expect(body['max_completion_tokens']).toBe(1024)
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('response_format')
  })

  it('mints a new token for each request', async () => {
    const tokens: string[] = []
    let tick = 1_000
    const model = createLiveKitInferenceTextModel({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      model: MODEL,
      nowSeconds: () => tick,
      tokenTtlSeconds: 60,
      fetchImpl: async (_url, init) => {
        tokens.push(
          String((init?.headers as Record<string, string> | undefined)?.['Authorization']),
        )
        tick += 10
        return sseResponse(['{"choices":[{"delta":{},"finish_reason":"stop"}]}', '[DONE]'])
      },
    })

    await collect(model)
    await collect(model)

    expect(tokens).toHaveLength(2)
    expect(tokens[0]).not.toBe(tokens[1])
    const exp = (token: string) => {
      const payload = token.split(' ')[1]?.split('.')[1] ?? ''
      return (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp: number }).exp
    }
    expect(exp(tokens[0] as string)).toBe(1_060)
    expect(exp(tokens[1] as string)).toBe(1_070)
  })

  it('accepts an explicit base URL and generation profile', async () => {
    let url = ''
    let body: Record<string, unknown> = {}
    const model = createLiveKitInferenceTextModel({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      model: MODEL,
      baseUrl: 'https://livekit.test/v1',
      generation: { temperature: 0.2, maxCompletionTokens: 64 },
      fetchImpl: async (requestUrl, init) => {
        url = String(requestUrl)
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return sseResponse(['{"choices":[{"delta":{},"finish_reason":"stop"}]}', '[DONE]'])
      },
    })

    await collect(model)

    expect(url).toBe('https://livekit.test/v1/chat/completions')
    expect(body['temperature']).toBe(0.2)
    expect(body['max_completion_tokens']).toBe(64)
    expect(body).not.toHaveProperty('top_p')
  })

  it('turns a non-2xx response into an error that does not leak the secret', async () => {
    const model = createLiveKitInferenceTextModel({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      model: MODEL,
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    })

    await expect(collect(model)).rejects.toMatchObject({
      name: 'LiveKitInferenceTextModelError',
      status: 401,
    })
    await expect(collect(model)).rejects.toThrow(/LiveKit Inference request failed with HTTP 401/)
    await expect(collect(model)).rejects.not.toThrow(API_SECRET)
  })

  it('reports request timing boundaries', async () => {
    const timings: LiveKitInferenceRequestTiming[] = []
    let clock = 0
    const model = createLiveKitInferenceTextModel({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      model: MODEL,
      now: () => {
        clock += 1
        return clock
      },
      onTiming: (timing) => timings.push(timing),
      fetchImpl: async () =>
        sseResponse([
          '{"choices":[{"delta":{"content":"hi"}}]}',
          '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
          '[DONE]',
        ]),
    })

    await collect(model)

    expect(timings).toHaveLength(1)
    expect(timings[0]?.ok).toBe(true)
    expect(timings[0]?.status).toBe(200)
    expect(timings[0]?.firstContentAt).toBeDefined()
  })

  it('refuses to start without a key, a secret or a model', () => {
    expect(() =>
      createLiveKitInferenceTextModel({ apiKey: '', apiSecret: API_SECRET, model: MODEL }),
    ).toThrow(/LIVEKIT_API_KEY/)
    expect(() =>
      createLiveKitInferenceTextModel({ apiKey: API_KEY, apiSecret: '', model: MODEL }),
    ).toThrow(/LIVEKIT_API_SECRET/)
    expect(() =>
      createLiveKitInferenceTextModel({ apiKey: API_KEY, apiSecret: API_SECRET, model: '' }),
    ).toThrow(/model id/)
  })
})
