import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessConfigError } from '@rp/eval-harness'
import type { TextModelChunk, TextModelPort } from '@rp/session-core'
import {
  createLiveProviderFactory,
  selectLiveProvider,
  type LiveProviderCredentials,
  type LiveProviderSelection,
} from './live-provider.js'

const OPENROUTER_LABEL = 'openrouter/openai/gpt-oss-safeguard-20b'
const LIVEKIT_LABEL = 'livekit/google/gemma-4-31b-it'

function fakeModel(): TextModelPort {
  return {
    kind: 'live',
    label: 'fake',
    async *complete(): AsyncIterable<TextModelChunk> {
      yield { text: 'hello', done: false }
      yield { text: '', done: true }
    },
  }
}

describe('live provider selection', () => {
  it('selects the OpenRouter safeguard model', () => {
    expect(selectLiveProvider(OPENROUTER_LABEL)).toEqual({
      kind: 'openrouter',
      modelId: 'openai/gpt-oss-safeguard-20b',
    })
  })

  it('selects the LiveKit Gemma model', () => {
    expect(selectLiveProvider(LIVEKIT_LABEL)).toEqual({
      kind: 'livekit',
      modelId: 'google/gemma-4-31b-it',
    })
  })

  it('selects the fixed Groq persona model', () => {
    expect(selectLiveProvider('groq/openai/gpt-oss-20b')).toEqual({
      kind: 'groq',
      modelId: 'openai/gpt-oss-20b',
    })
  })

  it('refuses to change the pinned Groq model', () => {
    expect(() => selectLiveProvider('groq/openai/gpt-oss-120b')).toThrow(/fixed/)
  })

  it('rejects an unknown or incomplete label', () => {
    expect(() => selectLiveProvider('openrouter/')).toThrow(/model id/)
    expect(() => selectLiveProvider('livekit/')).toThrow(/model id/)
    expect(() => selectLiveProvider('something-else')).toThrow(/must start with/)
  })

  it('requires the credentials that belong to the selected adapter', () => {
    expect(() =>
      createLiveProviderFactory({ label: OPENROUTER_LABEL, env: {}, paceMs: 0 }),
    ).toThrow(/OPENROUTER_API_KEY/)
    expect(() =>
      createLiveProviderFactory({ label: 'groq/openai/gpt-oss-20b', env: {}, paceMs: 0 }),
    ).toThrow(/GROQ_API_KEY/)
    expect(() => createLiveProviderFactory({ label: LIVEKIT_LABEL, env: {}, paceMs: 0 })).toThrow(
      /LIVEKIT_API_KEY/,
    )
    expect(() =>
      createLiveProviderFactory({
        label: LIVEKIT_LABEL,
        env: { LIVEKIT_API_KEY: 'test-key' },
        paceMs: 0,
      }),
    ).toThrow(/LIVEKIT_API_SECRET/)
  })

  it('passes adapter-specific default base URLs', () => {
    const seen: Array<{ kind: string; baseUrl: string; apiSecret?: string }> = []
    const capture = (selection: LiveProviderSelection, credentials: LiveProviderCredentials) => {
      seen.push({
        kind: selection.kind,
        baseUrl: credentials.baseUrl,
        ...(credentials.apiSecret === undefined ? {} : { apiSecret: credentials.apiSecret }),
      })
      return fakeModel()
    }

    createLiveProviderFactory({
      label: 'groq/openai/gpt-oss-20b',
      env: { GROQ_API_KEY: 'k' },
      paceMs: 0,
      createModel: capture,
    })()
    createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'k' },
      paceMs: 0,
      createModel: capture,
    })()
    createLiveProviderFactory({
      label: LIVEKIT_LABEL,
      env: { LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' },
      paceMs: 0,
      createModel: capture,
    })()

    expect(seen).toEqual([
      { kind: 'groq', baseUrl: 'https://api.groq.com/openai/v1' },
      { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
      { kind: 'livekit', baseUrl: 'https://agent-gateway.livekit.cloud/v1', apiSecret: 's' },
    ])
  })

  it('lets the environment override every base URL', () => {
    const seen: string[] = []
    const capture = (_selection: LiveProviderSelection, credentials: LiveProviderCredentials) => {
      seen.push(credentials.baseUrl)
      return fakeModel()
    }

    createLiveProviderFactory({
      label: 'groq/openai/gpt-oss-20b',
      env: { GROQ_API_KEY: 'k', GROQ_BASE_URL: 'https://groq.test/v1' },
      paceMs: 0,
      createModel: capture,
    })()
    createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'k', OPENROUTER_BASE_URL: 'https://openrouter.test/v1' },
      paceMs: 0,
      createModel: capture,
    })()
    createLiveProviderFactory({
      label: LIVEKIT_LABEL,
      env: {
        LIVEKIT_API_KEY: 'k',
        LIVEKIT_API_SECRET: 's',
        LIVEKIT_INFERENCE_URL: 'https://livekit.test/v1',
      },
      paceMs: 0,
      createModel: capture,
    })()

    expect(seen).toEqual([
      'https://groq.test/v1',
      'https://openrouter.test/v1',
      'https://livekit.test/v1',
    ])
  })

  it('builds a provider with the manifest label and injected model', async () => {
    let seenKey = ''
    const factory = createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'test-key' },
      paceMs: 0,
      createModel: (_selection, credentials) => {
        seenKey = credentials.apiKey
        return fakeModel()
      },
    })
    const provider = factory()

    const chunks: string[] = []
    for await (const chunk of provider.complete({
      provider: 'persona',
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk.text)
    }

    expect(provider.label).toBe(OPENROUTER_LABEL)
    expect(provider.kind).toBe('live')
    expect(seenKey).toBe('test-key')
    expect(chunks.join('')).toBe('hello')
  })

  it('retries a 429 before any text, then succeeds', async () => {
    let calls = 0
    const factory = createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'test-key' },
      paceMs: 0,
      retryBackoffMs: [0],
      createModel: () => ({
        kind: 'live',
        label: 'flaky',
        async *complete(): AsyncIterable<TextModelChunk> {
          calls += 1
          if (calls === 1) throw Object.assign(new Error('rate limited'), { status: 429 })
          yield { text: 'ok', done: true }
        },
      }),
    })

    const chunks: string[] = []
    for await (const chunk of factory().complete({
      provider: 'persona',
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk.text)
    }

    expect(calls).toBe(2)
    expect(chunks.join('')).toBe('ok')
  })

  it('does not retry a non-429 failure', async () => {
    let calls = 0
    const factory = createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'test-key' },
      paceMs: 0,
      retryBackoffMs: [0],
      createModel: () => ({
        kind: 'live',
        label: 'broken',
        complete(): AsyncIterable<TextModelChunk> {
          calls += 1
          throw new Error('bad request')
        },
      }),
    })

    await expect(async () => {
      for await (const _chunk of factory().complete({
        provider: 'persona',
        model: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        // no chunks
      }
    }).rejects.toThrow(/bad request/)
    expect(calls).toBe(1)
  })

  it('does not replay a mid-stream 429', async () => {
    let calls = 0
    const factory = createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'test-key' },
      paceMs: 0,
      retryBackoffMs: [0],
      createModel: () => ({
        kind: 'live',
        label: 'mid-stream',
        async *complete(): AsyncIterable<TextModelChunk> {
          calls += 1
          yield { text: 'partial', done: false }
          throw Object.assign(new Error('rate limited'), { status: 429 })
        },
      }),
    })

    const chunks: string[] = []
    await expect(async () => {
      for await (const chunk of factory().complete({
        provider: 'persona',
        model: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        chunks.push(chunk.text)
      }
    }).rejects.toThrow(/rate limited/)
    expect(calls).toBe(1)
    expect(chunks.join('')).toBe('partial')
  })
})

const REQUEST = {
  provider: 'persona',
  model: 'test',
  messages: [{ role: 'user' as const, content: 'hi' }],
}

async function drain(stream: AsyncIterable<TextModelChunk>): Promise<string> {
  let text = ''
  for await (const chunk of stream) text += chunk.text
  return text
}

/** A model whose first read fails with `error`, without yielding any text. */
function failingModel(error: unknown, onCall: () => void): TextModelPort {
  return {
    kind: 'live',
    label: 'failing',
    complete(): AsyncIterable<TextModelChunk> {
      onCall()
      return {
        [Symbol.asyncIterator]: () => ({
          next: (): Promise<IteratorResult<TextModelChunk>> => Promise.reject(error),
        }),
      }
    },
  }
}

function captureError(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the call to throw')
}

interface CapturedHttp {
  readonly url: string
  readonly authorization: string | null
  readonly title: string | null
  readonly body: { readonly model?: string; readonly stream?: boolean; readonly messages?: unknown }
}

/** Fake the HTTP layer so the real adapters stream a canned SSE reply. */
function stubStreamingFetch(): CapturedHttp[] {
  const calls: CapturedHttp[] = []
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(input),
        authorization: headers.get('authorization'),
        title: headers.get('x-title'),
        body: JSON.parse(String(init?.body)) as CapturedHttp['body'],
      })
      return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('live provider label errors', () => {
  it.each([
    ['openrouter/', 'an openrouter/ live label must name a model id'],
    ['livekit/', 'a livekit/ live label must name a model id'],
    [
      'groq/openai/gpt-oss-120b',
      'the Groq persona model is fixed to openai/gpt-oss-20b; refusing label "groq/openai/gpt-oss-120b"',
    ],
    ['', 'live provider label "" must start with "groq/", "openrouter/" or "livekit/"'],
    ['groq', 'live provider label "groq" must start with "groq/", "openrouter/" or "livekit/"'],
  ])('rejects %s with the exact message', (label, message) => {
    const error = captureError(() => selectLiveProvider(label))

    expect(error).toBeInstanceOf(HarnessConfigError)
    expect(error.name).toBe('HarnessConfigError')
    expect(error.message).toBe(message)
  })
})

describe('live provider credentials', () => {
  it('resolves the exact selection and credentials for each adapter', () => {
    const seen: Array<{ selection: LiveProviderSelection; credentials: LiveProviderCredentials }> =
      []
    const capture = (selection: LiveProviderSelection, credentials: LiveProviderCredentials) => {
      seen.push({ selection, credentials })
      return fakeModel()
    }

    createLiveProviderFactory({
      label: 'groq/openai/gpt-oss-20b',
      env: { GROQ_API_KEY: 'groq-key' },
      paceMs: 0,
      createModel: capture,
    })()
    createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'openrouter-key' },
      paceMs: 0,
      createModel: capture,
    })()
    createLiveProviderFactory({
      label: LIVEKIT_LABEL,
      env: { LIVEKIT_API_KEY: 'lk-key', LIVEKIT_API_SECRET: 'lk-secret' },
      paceMs: 0,
      createModel: capture,
    })()

    expect(seen).toStrictEqual([
      {
        selection: { kind: 'groq', modelId: 'openai/gpt-oss-20b' },
        credentials: { apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' },
      },
      {
        selection: { kind: 'openrouter', modelId: 'openai/gpt-oss-safeguard-20b' },
        credentials: {
          apiKey: 'openrouter-key',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
      },
      {
        selection: { kind: 'livekit', modelId: 'google/gemma-4-31b-it' },
        credentials: {
          apiKey: 'lk-key',
          apiSecret: 'lk-secret',
          baseUrl: 'https://agent-gateway.livekit.cloud/v1',
        },
      },
    ])
  })

  it.each([
    { label: 'groq/openai/gpt-oss-20b', env: { GROQ_API_KEY: '   ' }, name: 'GROQ_API_KEY' },
    { label: OPENROUTER_LABEL, env: { OPENROUTER_API_KEY: '\t' }, name: 'OPENROUTER_API_KEY' },
    {
      label: LIVEKIT_LABEL,
      env: { LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: 's' },
      name: 'LIVEKIT_API_KEY',
    },
    {
      label: LIVEKIT_LABEL,
      env: { LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: ' ' },
      name: 'LIVEKIT_API_SECRET',
    },
  ])('requires $name even when it is blank', ({ label, env, name }) => {
    const error = captureError(() => createLiveProviderFactory({ label, env, paceMs: 0 }))

    expect(error).toBeInstanceOf(HarnessConfigError)
    expect(error.message).toBe(`a live run requires ${name} (set it in .env or the environment)`)
  })

  it('trims an optional base URL and falls back when it is blank', () => {
    const urls: string[] = []
    const capture = (_selection: LiveProviderSelection, credentials: LiveProviderCredentials) => {
      urls.push(credentials.baseUrl)
      return fakeModel()
    }

    for (const value of ['  https://groq.test/v1  ', '   ']) {
      createLiveProviderFactory({
        label: 'groq/openai/gpt-oss-20b',
        env: { GROQ_API_KEY: 'k', GROQ_BASE_URL: value },
        paceMs: 0,
        createModel: capture,
      })()
    }

    expect(urls).toStrictEqual(['https://groq.test/v1', 'https://api.groq.com/openai/v1'])
  })
})

describe('live provider adapters', () => {
  it.each([
    {
      label: 'groq/openai/gpt-oss-20b',
      env: { GROQ_API_KEY: 'groq-key' },
      url: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'openai/gpt-oss-20b',
      authorization: 'Bearer groq-key',
      title: null,
    },
    {
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'openrouter-key' },
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'openai/gpt-oss-safeguard-20b',
      authorization: 'Bearer openrouter-key',
      title: 'role-playing-eval',
    },
  ])('sends $model through the $label adapter', async (adapter) => {
    const calls = stubStreamingFetch()

    const factory = createLiveProviderFactory({
      label: adapter.label,
      env: adapter.env,
      paceMs: 0,
    })

    expect(await drain(factory().complete(REQUEST))).toBe('hi')
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.url).toBe(adapter.url)
    expect(call?.authorization).toBe(adapter.authorization)
    expect(call?.title).toBe(adapter.title)
    expect(call?.body).toMatchObject({
      model: adapter.model,
      messages: REQUEST.messages,
      stream: true,
    })
  })

  it('sends the pinned Gemma model through LiveKit Inference with a minted token', async () => {
    const calls = stubStreamingFetch()
    const factory = createLiveProviderFactory({
      label: LIVEKIT_LABEL,
      env: { LIVEKIT_API_KEY: 'lk-key', LIVEKIT_API_SECRET: 'lk-secret' },
      paceMs: 0,
    })

    expect(await drain(factory().complete(REQUEST))).toBe('hi')
    const call = calls[0]
    expect(call?.url).toBe('https://agent-gateway.livekit.cloud/v1/chat/completions')
    expect(call?.body).toMatchObject({ model: 'google/gemma-4-31b-it', stream: true })
    expect(call?.authorization?.startsWith('Bearer ')).toBe(true)

    const token = call?.authorization?.slice('Bearer '.length) ?? ''
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as unknown
    expect(payload).toMatchObject({
      iss: 'lk-key',
      sub: 'agent',
      inference: { perform: true },
    })
  })
})

describe('live provider streaming', () => {
  it('builds a fresh model per trial and paces calls across the run', async () => {
    let models = 0
    const factory = createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'k' },
      paceMs: 300,
      createModel: () => {
        models += 1
        return fakeModel()
      },
    })

    const first = factory()
    const second = factory()
    expect(models).toBe(2)

    const startedAt = Date.now()
    await drain(first.complete(REQUEST))
    const firstDoneAt = Date.now()
    await drain(second.complete(REQUEST))
    const secondDoneAt = Date.now()

    expect(firstDoneAt - startedAt).toBeLessThan(200)
    expect(secondDoneAt - firstDoneAt).toBeGreaterThanOrEqual(250)
  })

  it('forwards the messages, request metadata and complete options to the model', async () => {
    const modelRequests: unknown[] = []
    const modelOptions: unknown[] = []
    const controller = new AbortController()
    const factory = createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'k' },
      paceMs: 0,
      createModel: () => ({
        kind: 'live',
        label: 'recorder',
        async *complete(request, options): AsyncIterable<TextModelChunk> {
          modelRequests.push(request)
          modelOptions.push(options)
          yield { text: 'ok', done: true }
        },
      }),
    })

    await drain(
      factory().complete(
        { ...REQUEST, metadata: { requestId: 'round-1' } },
        {
          signal: controller.signal,
        },
      ),
    )
    await drain(factory().complete(REQUEST))

    expect(modelRequests).toStrictEqual([
      { messages: REQUEST.messages, metadata: { requestId: 'round-1' } },
      { messages: REQUEST.messages },
    ])
    expect(modelOptions).toStrictEqual([{ signal: controller.signal }, undefined])
  })

  it('stops after four retries of the same rate-limited request', async () => {
    let calls = 0
    const factory = createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'k' },
      paceMs: 0,
      retryBackoffMs: [0],
      createModel: () =>
        failingModel(Object.assign(new Error('rate limited'), { status: 429 }), () => {
          calls += 1
        }),
    })

    await expect(drain(factory().complete(REQUEST))).rejects.toThrow('rate limited')
    expect(calls).toBe(5)
  })

  it('surfaces a thrown value that is not an error object without retrying', async () => {
    let calls = 0
    const factory = createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'k' },
      paceMs: 0,
      retryBackoffMs: [0],
      createModel: () =>
        failingModel('rate limited', () => {
          calls += 1
        }),
    })

    await expect(drain(factory().complete(REQUEST))).rejects.toBe('rate limited')
    expect(calls).toBe(1)
  })

  it('does not retry an error that carries a non-rate-limit status', async () => {
    let calls = 0
    const factory = createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'k' },
      paceMs: 0,
      retryBackoffMs: [0],
      createModel: () =>
        failingModel(Object.assign(new Error('bad request'), { status: 400 }), () => {
          calls += 1
        }),
    })

    await expect(drain(factory().complete(REQUEST))).rejects.toThrow('bad request')
    expect(calls).toBe(1)
  })

  it('surfaces a null throw without retrying', async () => {
    let calls = 0
    const factory = createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'k' },
      paceMs: 0,
      retryBackoffMs: [0],
      createModel: () =>
        failingModel(null, () => {
          calls += 1
        }),
    })

    await expect(drain(factory().complete(REQUEST))).rejects.toBeNull()
    expect(calls).toBe(1)
  })

  it('waits for the configured backoff before retrying', async () => {
    let calls = 0
    const factory = createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'k' },
      paceMs: 0,
      retryBackoffMs: [1],
      createModel: () => ({
        kind: 'live',
        label: 'flaky',
        async *complete(): AsyncIterable<TextModelChunk> {
          calls += 1
          if (calls === 1) throw Object.assign(new Error('rate limited'), { status: 429 })
          yield { text: 'ok', done: true }
        },
      }),
    })

    const startedAt = Date.now()
    expect(await drain(factory().complete(REQUEST))).toBe('ok')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(calls).toBe(2)
  })

  it('does not pace a first call and tolerates an already-aborted signal', async () => {
    const factory = createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'k' },
      paceMs: 0,
      createModel: () => fakeModel(),
    })
    const controller = new AbortController()
    controller.abort()

    await expect(drain(factory().complete(REQUEST, { signal: controller.signal }))).resolves.toBe(
      'hello',
    )
  })

  it('registers one abort listener and clears the pace timer when it fires', async () => {
    vi.useFakeTimers()
    try {
      const factory = createLiveProviderFactory({
        label: OPENROUTER_LABEL,
        env: { OPENROUTER_API_KEY: 'k' },
        paceMs: 1_000,
        createModel: () => fakeModel(),
      })
      await drain(factory().complete(REQUEST))

      const controller = new AbortController()
      const addEventListener = vi.spyOn(controller.signal, 'addEventListener')
      const pending = drain(factory().complete(REQUEST, { signal: controller.signal }))

      expect(vi.getTimerCount()).toBe(1)
      expect(addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), {
        once: true,
      })

      controller.abort()

      await expect(pending).rejects.toThrow('paced request was aborted')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a paced wait whose signal is already aborted', async () => {
    const factory = createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'k' },
      paceMs: 5_000,
      createModel: () => fakeModel(),
    })
    await drain(factory().complete(REQUEST))

    const controller = new AbortController()
    controller.abort()

    await expect(drain(factory().complete(REQUEST, { signal: controller.signal }))).rejects.toThrow(
      'paced request was aborted',
    )
  })

  it('clears a pending pace timer when the signal aborts', async () => {
    const factory = createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'k' },
      paceMs: 5_000,
      createModel: () => fakeModel(),
    })
    await drain(factory().complete(REQUEST))

    const controller = new AbortController()
    const pending = drain(factory().complete(REQUEST, { signal: controller.signal }))
    setTimeout(() => controller.abort(), 5)

    await expect(pending).rejects.toThrow('paced request was aborted')
  })

  it('disposes the underlying model and tolerates a model without dispose', async () => {
    const disposed = vi.fn(() => Promise.resolve())
    const withDispose = createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'k' },
      paceMs: 0,
      createModel: () => ({ ...fakeModel(), dispose: disposed }),
    })()
    await withDispose.dispose?.()
    expect(disposed).toHaveBeenCalledTimes(1)

    const bare = createLiveProviderFactory({
      label: OPENROUTER_LABEL,
      env: { OPENROUTER_API_KEY: 'k' },
      paceMs: 0,
      createModel: () => fakeModel(),
    })()
    expect(bare.dispose?.()).toBeUndefined()
  })
})
