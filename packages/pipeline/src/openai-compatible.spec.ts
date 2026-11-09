import type { TextModelChunk, TextModelRequest } from '@rp/session-core'
import { describe, expect, it, vi } from 'vitest'
import {
  bodyForGeneration,
  defaultTimingClock,
  streamOpenAiCompatible,
  type CreateProviderErrorOptions,
  type OpenAiCompatibleStreamOptions,
  type TextRequestTiming,
} from './openai-compatible.js'

const REQUEST: TextModelRequest = { messages: [{ role: 'user', content: 'hello' }] }

class ProviderError extends Error {
  readonly status: number | undefined

  constructor(message: string, options: CreateProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProviderError'
    this.status = options.status
  }
}

function sse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function dataLines(...events: readonly string[]): Response {
  return sse(`${events.map((event) => `data: ${event}`).join('\n')}\n`)
}

function options(
  overrides: Partial<OpenAiCompatibleStreamOptions> = {},
): OpenAiCompatibleStreamOptions {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    request: REQUEST,
    signal: undefined,
    fetchImpl: async () => dataLines('[DONE]'),
    onTiming: undefined,
    now: () => 0,
    providerName: 'TestProvider',
    createError: (message, errorOptions) => new ProviderError(message, errorOptions),
    ...overrides,
  }
}

async function collect(stream: AsyncIterable<TextModelChunk>): Promise<TextModelChunk[]> {
  const chunks: TextModelChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('OpenAI-compatible streaming', () => {
  it('uses the performance clock by default', () => {
    expect(typeof defaultTimingClock()).toBe('function')
    expect(typeof defaultTimingClock()()).toBe('number')
  })

  it('normalises every trailing slash in the base URL', async () => {
    let url = ''
    await collect(
      streamOpenAiCompatible(
        options({
          baseUrl: 'https://example.test/v1///',
          fetchImpl: async (requestUrl) => {
            url = String(requestUrl)
            return dataLines('[DONE]')
          },
        }),
      ),
    )
    expect(url).toBe('https://example.test/v1/chat/completions')
  })

  it('sends the standard headers and merges caller headers last', async () => {
    let init: RequestInit | undefined
    await collect(
      streamOpenAiCompatible(
        options({
          headers: { 'X-Title': 'bench', Authorization: 'Bearer override' },
          fetchImpl: async (_url, requestInit) => {
            init = requestInit
            return dataLines('[DONE]')
          },
        }),
      ),
    )
    expect(init?.headers).toEqual({
      Authorization: 'Bearer override',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-Title': 'bench',
    })
  })

  it('reports a pre-response failure with a false timing outcome', async () => {
    const failure = new Error('socket closed')
    const timings: TextRequestTiming[] = []
    const stream = streamOpenAiCompatible(
      options({
        fetchImpl: async () => {
          throw failure
        },
        onTiming: (timing) => timings.push(timing),
        now: () => 7,
      }),
    )
    await expect(collect(stream)).rejects.toBeInstanceOf(ProviderError)
    expect(timings).toEqual([{ requestStartedAt: 7, finishedAt: 7, ok: false }])
    expect('requestId' in timings[0]!).toBe(false)
    expect('responseHeadersAt' in timings[0]!).toBe(false)
    expect('firstContentAt' in timings[0]!).toBe(false)
    expect('status' in timings[0]!).toBe(false)
  })

  it('rethrows the original error when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const stream = streamOpenAiCompatible(
      options({
        signal: controller.signal,
        fetchImpl: async () => {
          throw new Error('aborted fetch')
        },
      }),
    )
    await expect(collect(stream)).rejects.toThrow('aborted fetch')
  })

  it('rejects a non-2xx response and a missing body', async () => {
    const limited = streamOpenAiCompatible(
      options({ fetchImpl: async () => new Response('no', { status: 429 }) }),
    )
    await expect(collect(limited)).rejects.toMatchObject({ status: 429 })

    const noBody = streamOpenAiCompatible(
      options({ fetchImpl: async () => new Response(null, { status: 200 }) }),
    )
    await expect(collect(noBody)).rejects.toThrow('TestProvider returned no response body')
  })

  it('skips blank lines and non-data SSE fields', async () => {
    const stream = streamOpenAiCompatible(
      options({
        fetchImpl: async () =>
          sse(
            [
              ': keep-alive',
              'event: message',
              '',
              'data: {"choices":[{"delta":{"content":"ok"}}]}',
              '',
              'data: [DONE]',
              '',
            ].join('\n'),
          ),
      }),
    )
    expect(await collect(stream)).toStrictEqual([
      { text: 'ok', done: false },
      { text: '', done: true },
    ])
  })

  it('does not treat a null finish_reason as a valid end', async () => {
    const stream = streamOpenAiCompatible(
      options({
        fetchImpl: async () =>
          dataLines('{"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}'),
      }),
    )
    await expect(collect(stream)).rejects.toThrow(
      'TestProvider stream ended without a [DONE] marker or finish_reason',
    )
  })

  it('tolerates a choice without a delta and ignores empty content', async () => {
    const stream = streamOpenAiCompatible(
      options({
        fetchImpl: async () =>
          dataLines(
            '{"choices":[{}]}',
            '{"choices":[{"delta":{"content":""}}]}',
            '{"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}',
          ),
      }),
    )
    expect(await collect(stream)).toStrictEqual([{ text: '', done: true }])
  })

  it('cancels the reader when the stream ends', async () => {
    const cancel = vi.fn(async () => undefined)
    const body = {
      getReader() {
        let sent = false
        return {
          async read() {
            if (sent) return { done: true, value: undefined }
            sent = true
            return {
              done: false,
              value: new TextEncoder().encode('data: [DONE]\n'),
            }
          },
          cancel,
        }
      },
    } as unknown as ReadableStream<Uint8Array>

    const stream = streamOpenAiCompatible(
      options({ fetchImpl: async () => ({ ok: true, status: 200, body }) as Response }),
    )
    await collect(stream)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('includes only the timing fields that were observed', async () => {
    const timings: TextRequestTiming[] = []
    await collect(
      streamOpenAiCompatible(
        options({
          request: { ...REQUEST, requestId: 'req-1' },
          now: () => 1,
          onTiming: (timing) => timings.push(timing),
          fetchImpl: async () => dataLines('[DONE]'),
        }),
      ),
    )
    expect(timings).toEqual([
      {
        requestId: 'req-1',
        requestStartedAt: 1,
        responseHeadersAt: 1,
        finishedAt: 1,
        ok: true,
        status: 200,
      },
    ])
    expect('firstContentAt' in timings[0]!).toBe(false)
  })

  it('omits usage from the final chunk when nothing was reported', async () => {
    const stream = streamOpenAiCompatible(options())
    expect(await collect(stream)).toStrictEqual([{ text: '', done: true }])
  })

  it('maps every usage field and prefers x_groq usage', async () => {
    const stream = streamOpenAiCompatible(
      options({
        fetchImpl: async () =>
          dataLines(
            '{"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":1}}',
            '{"choices":[{"delta":{}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"cost":0.25}}',
            '{"choices":[{"delta":{}}],"x_groq":{"usage":{"prompt_tokens":4}},"usage":{"prompt_tokens":99}}',
            '[DONE]',
          ),
      }),
    )
    expect(await collect(stream)).toStrictEqual([
      { text: 'ok', done: false },
      { text: '', done: true, usage: { inputTokens: 4 } },
    ])
  })

  it('ignores empty or non-object usage', async () => {
    for (const usage of ['{}', '42', '"text"', 'null']) {
      const stream = streamOpenAiCompatible(
        options({ fetchImpl: async () => dataLines(`{"usage":${usage}}`, '[DONE]') }),
      )
      expect(await collect(stream)).toStrictEqual([{ text: '', done: true }])
    }
  })

  it('maps cost and completion tokens on their own', async () => {
    const cost = streamOpenAiCompatible(
      options({ fetchImpl: async () => dataLines('{"usage":{"cost":0.5}}', '[DONE]') }),
    )
    expect((await collect(cost)).at(-1)).toStrictEqual({
      text: '',
      done: true,
      usage: { costUsd: 0.5 },
    })

    const output = streamOpenAiCompatible(
      options({ fetchImpl: async () => dataLines('{"usage":{"completion_tokens":3}}', '[DONE]') }),
    )
    expect((await collect(output)).at(-1)).toStrictEqual({
      text: '',
      done: true,
      usage: { outputTokens: 3 },
    })
  })

  it('rejects malformed and non-object data lines with a cause', async () => {
    const malformed = streamOpenAiCompatible(
      options({ fetchImpl: async () => dataLines('{"choices":', '[DONE]') }),
    )
    try {
      await collect(malformed)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError)
      expect((error as Error).message).toBe('stream contained a malformed data line')
      expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(SyntaxError)
    }

    for (const line of ['null', '42', '"text"']) {
      const nonObject = streamOpenAiCompatible(
        options({ fetchImpl: async () => dataLines(line, '[DONE]') }),
      )
      await expect(collect(nonObject)).rejects.toThrow('stream contained a non-object data line')
    }
  })

  it('sends every generation field that is defined and omits the rest', async () => {
    let body: Record<string, unknown> = {}
    await collect(
      streamOpenAiCompatible(
        options({
          generation: {
            temperature: 0.1,
            topP: 0.2,
            maxCompletionTokens: 3,
            reasoningEffort: 'high',
            includeReasoning: true,
          },
          fetchImpl: async (_url, init) => {
            body = JSON.parse(String(init?.body)) as Record<string, unknown>
            return dataLines('[DONE]')
          },
        }),
      ),
    )
    expect(body).toMatchObject({
      temperature: 0.1,
      top_p: 0.2,
      max_completion_tokens: 3,
      reasoning_effort: 'high',
      include_reasoning: true,
    })
    expect(body).not.toHaveProperty('response_format')
  })

  it('omits every undefined generation field from the body object', () => {
    expect(bodyForGeneration(undefined)).toStrictEqual({})
    expect(bodyForGeneration({})).toStrictEqual({})
    expect(Object.keys(bodyForGeneration({}))).toEqual([])
    expect(
      bodyForGeneration({
        temperature: 0,
        topP: 0,
        maxCompletionTokens: 0,
        reasoningEffort: 'low',
        includeReasoning: false,
      }),
    ).toStrictEqual({
      temperature: 0,
      top_p: 0,
      max_completion_tokens: 0,
      reasoning_effort: 'low',
      include_reasoning: false,
    })
  })

  it('decodes a multibyte character split across network chunks', async () => {
    const payload = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"é"}}]}\ndata: [DONE]\n',
    )
    const bytes = new TextEncoder().encode('é')
    const split = payload.indexOf(bytes[0] as number) + 1
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload.slice(0, split))
        controller.enqueue(payload.slice(split))
        controller.close()
      },
    })
    const stream = streamOpenAiCompatible(
      options({ fetchImpl: async () => new Response(body, { status: 200 }) }),
    )
    expect(await collect(stream)).toStrictEqual([
      { text: 'é', done: false },
      { text: '', done: true },
    ])
  })

  it('trims whitespace around an SSE data line', async () => {
    const stream = streamOpenAiCompatible(
      options({
        fetchImpl: async () =>
          sse('   data: {"choices":[{"delta":{"content":"ok"}}]}   \n   data: [DONE]   \n'),
      }),
    )
    expect(await collect(stream)).toStrictEqual([
      { text: 'ok', done: false },
      { text: '', done: true },
    ])
  })

  it('tolerates a generation profile with no fields', async () => {
    let body: Record<string, unknown> = {}
    await collect(
      streamOpenAiCompatible(
        options({
          generation: {},
          fetchImpl: async (_url, init) => {
            body = JSON.parse(String(init?.body)) as Record<string, unknown>
            return dataLines('[DONE]')
          },
        }),
      ),
    )
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('top_p')
    expect(body).not.toHaveProperty('max_completion_tokens')
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('include_reasoning')
  })
})
