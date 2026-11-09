import { describe, expect, it } from 'vitest'
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
