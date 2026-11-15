import { describe, expect, it } from 'vitest'
import {
  CannedProviderConfigError,
  CannedProviderMissError,
  ProviderUnavailableError,
  ReplayAbortedError,
  cannedRequestHash,
  createCannedProvider,
  createLiveProvider,
  type CompletionChunk,
  type CompletionRequest,
} from './canned-provider.js'

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    provider: 'persona',
    model: 'canned/persona-v1',
    messages: [{ role: 'user', content: 'Bonjour' }],
    metadata: { taskId: 'fr-b1-rapport-delai-001', turnIndex: '1' },
    ...overrides,
  }
}

async function collect(
  iterable: AsyncIterable<{ text: string; done: boolean }>,
): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of iterable) chunks.push(`${chunk.text}${chunk.done ? '|done' : ''}`)
  return chunks
}

async function collectExact(iterable: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const chunks: CompletionChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function capture(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

describe('canned provider', () => {
  it('replays recorded chunks keyed by canonical payload hash', async () => {
    const recorded = request()
    const provider = createCannedProvider([
      { request: recorded, chunks: ['Bonjour, ', 'je vous écoute.'] },
    ])

    await expect(collect(provider.complete(recorded))).resolves.toEqual([
      'Bonjour, ',
      'je vous écoute.|done',
    ])
  })

  it('is insensitive to metadata key order because the hash is canonical', () => {
    const first = request({ metadata: { taskId: 'en-001', turnIndex: '3' } })
    const second = request({ metadata: { turnIndex: '3', taskId: 'en-001' } })

    expect(cannedRequestHash(first)).toBe(cannedRequestHash(second))
  })

  it('throws a typed miss for an unmatched payload hash and never falls back', () => {
    const provider = createCannedProvider([{ request: request(), chunks: ['recorded'] }])
    const unrecorded = request({ messages: [{ role: 'user', content: 'Different payload' }] })

    let thrown: unknown
    try {
      provider.complete(unrecorded)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CannedProviderMissError)
    if (!(thrown instanceof CannedProviderMissError)) return
    expect(thrown.payloadHash).toBe(cannedRequestHash(unrecorded))
    expect(thrown.message).toContain('refusing to fall back')
    expect(thrown.message).not.toContain('Different payload')
  })

  it('refuses duplicate payload hashes instead of picking one silently', () => {
    expect(() =>
      createCannedProvider([
        { request: request(), chunks: ['first'] },
        { request: request(), chunks: ['second'] },
      ]),
    ).toThrow(CannedProviderConfigError)
  })

  it('refuses an entry with no chunks', () => {
    expect(() => createCannedProvider([{ request: request(), chunks: [] }])).toThrow(
      CannedProviderConfigError,
    )
  })

  it('live provider is explicitly labeled and performs no network call', () => {
    const provider = createLiveProvider('m0-live-not-wired')
    expect(provider.kind).toBe('live')
    expect(provider.label).toBe('m0-live-not-wired')
    expect(() => provider.complete(request())).toThrow(ProviderUnavailableError)
  })
})

describe('canned provider surface', () => {
  it('labels a canned provider with the default and explicit label', () => {
    const defaulted = createCannedProvider([{ request: request(), chunks: ['ok'] }])
    const labelled = createCannedProvider([{ request: request(), chunks: ['ok'] }], 'suite-replay')

    expect(defaulted.kind).toBe('canned')
    expect(defaulted.label).toBe('canned-replay')
    expect(labelled.kind).toBe('canned')
    expect(labelled.label).toBe('suite-replay')
    expect(defaulted.dispose).toBeUndefined()
  })

  it('streams one chunk per recorded string with done only on the last', async () => {
    const recorded = request()
    const provider = createCannedProvider([{ request: recorded, chunks: ['a', 'b', 'c'] }])

    await expect(collectExact(provider.complete(recorded))).resolves.toStrictEqual([
      { text: 'a', done: false },
      { text: 'b', done: false },
      { text: 'c', done: true },
    ])
  })

  it('marks a single-chunk response as done', async () => {
    const recorded = request()
    const provider = createCannedProvider([{ request: recorded, chunks: ['only'] }])

    await expect(collectExact(provider.complete(recorded))).resolves.toStrictEqual([
      { text: 'only', done: true },
    ])
  })

  it('aborts a replay when the signal is already aborted', async () => {
    const recorded = request()
    const provider = createCannedProvider([{ request: recorded, chunks: ['a', 'b'] }])
    const controller = new AbortController()
    controller.abort()

    const iterator = provider
      .complete(recorded, { signal: controller.signal })
      [Symbol.asyncIterator]()

    const thrown = await iterator.next().then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(ReplayAbortedError)
    if (!(thrown instanceof ReplayAbortedError)) return
    expect(thrown.name).toBe('ReplayAbortedError')
    expect(thrown.message).toBe('canned replay was aborted')
  })

  it('aborts a replay between chunks once the signal fires', async () => {
    const recorded = request()
    const provider = createCannedProvider([{ request: recorded, chunks: ['a', 'b'] }])
    const controller = new AbortController()
    const iterator = provider
      .complete(recorded, { signal: controller.signal })
      [Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toStrictEqual({
      value: { text: 'a', done: false },
      done: false,
    })

    controller.abort()
    const thrown = await iterator.next().then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(ReplayAbortedError)
    if (!(thrown instanceof ReplayAbortedError)) return
    expect(thrown.name).toBe('ReplayAbortedError')
    expect(thrown.message).toBe('canned replay was aborted')
  })

  it('replays to completion with a signal that never aborts', async () => {
    const recorded = request()
    const provider = createCannedProvider([{ request: recorded, chunks: ['a', 'b'] }])
    const controller = new AbortController()

    await expect(
      collect(provider.complete(recorded, { signal: controller.signal })),
    ).resolves.toEqual(['a', 'b|done'])
  })

  it('copies the recorded chunks so later mutation of the source cannot change replay', async () => {
    const recorded = request()
    const chunks = ['first']
    const provider = createCannedProvider([{ request: recorded, chunks }])
    chunks.push('second')

    await expect(collect(provider.complete(recorded))).resolves.toEqual(['first|done'])
  })

  it('uses the parsed request for the key so equivalent raw payloads hit', async () => {
    const recorded = request({ metadata: undefined })
    const provider = createCannedProvider([{ request: recorded, chunks: ['hit'] }])

    await expect(collect(provider.complete(request({ metadata: undefined })))).resolves.toEqual([
      'hit|done',
    ])
  })
})

describe('canned request hash', () => {
  it('is a lowercase SHA-256 digest of the canonical request', () => {
    const hash = cannedRequestHash(request())
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).toBe(cannedRequestHash(request()))
  })

  it('separates requests that differ only in metadata or provider', () => {
    const hashes = new Set([
      cannedRequestHash(request()),
      cannedRequestHash(
        request({ metadata: { taskId: 'fr-b1-rapport-delai-001', turnIndex: '2' } }),
      ),
      cannedRequestHash(request({ metadata: undefined })),
      cannedRequestHash(request({ provider: 'other' })),
      cannedRequestHash(request({ model: 'canned/other' })),
      cannedRequestHash(request({ messages: [{ role: 'user', content: 'Salut' }] })),
    ])

    expect(hashes.size).toBe(6)
  })
})

describe('canned provider misconfiguration', () => {
  it('reports the exact miss message, hash and labels', () => {
    const provider = createCannedProvider([{ request: request(), chunks: ['recorded'] }])
    const unrecorded = request({ provider: 'peer', model: 'canned/peer-v2' })
    const hash = cannedRequestHash(unrecorded)

    const thrown = capture(() => provider.complete(unrecorded))

    expect(thrown).toBeInstanceOf(CannedProviderMissError)
    if (!(thrown instanceof CannedProviderMissError)) return
    expect(thrown.name).toBe('CannedProviderMissError')
    expect(thrown.message).toBe(
      `no canned response for payload hash ${hash} (provider "peer", model "canned/peer-v2"); refusing to fall back`,
    )
    expect(thrown.payloadHash).toBe(hash)
    expect(thrown.provider).toBe('peer')
    expect(thrown.model).toBe('canned/peer-v2')
  })

  it('reports the exact duplicate-payload message', () => {
    const hash = cannedRequestHash(request())

    expect(() =>
      createCannedProvider([
        { request: request(), chunks: ['first'] },
        { request: request(), chunks: ['second'] },
      ]),
    ).toThrow(
      new CannedProviderConfigError(
        `canned entry 1 duplicates payload hash ${hash}; each request payload must be unique`,
      ),
    )
  })

  it('reports the exact missing-chunks message with the entry index', () => {
    expect(() =>
      createCannedProvider([
        { request: request(), chunks: ['ok'] },
        { request: request({ model: 'other' }), chunks: [] },
      ]),
    ).toThrow(new CannedProviderConfigError('canned entry 1 has no response chunks'))
  })

  it('names the config error and keeps the message verbatim', () => {
    const thrown = capture(() => createCannedProvider([{ request: request(), chunks: [] }]))

    expect(thrown).toBeInstanceOf(CannedProviderConfigError)
    if (!(thrown instanceof CannedProviderConfigError)) return
    expect(thrown.name).toBe('CannedProviderConfigError')
    expect(thrown.message).toBe('canned entry 0 has no response chunks')
  })

  it.each([
    {
      label: 'an empty provider',
      invalid: { ...request(), provider: '' },
      issue: 'provider: Too small: expected string to have >=1 characters',
    },
    {
      label: 'an empty model',
      invalid: { ...request(), model: '' },
      issue: 'model: Too small: expected string to have >=1 characters',
    },
    {
      label: 'an unknown root key',
      invalid: { ...request(), extra: true },
      issue: '<root>: Unrecognized key: "extra"',
    },
    {
      label: 'an unknown message key',
      invalid: { ...request(), messages: [{ role: 'user', content: 'x', extra: 'y' }] },
      issue: 'messages.0: Unrecognized key: "extra"',
    },
    {
      label: 'an unknown role',
      invalid: { ...request(), messages: [{ role: 'tool', content: 'x' }] },
      issue: 'messages.0.role: Invalid option: expected one of "system"|"user"|"assistant"',
    },
    {
      label: 'a non-string metadata value',
      invalid: { ...request(), metadata: { turn: 1 } },
      issue: 'metadata.turn: Invalid input: expected string, received number',
    },
  ])('rejects $label with the exact issue path and message', ({ invalid, issue }) => {
    expect(() =>
      createCannedProvider([
        { request: invalid as unknown as CompletionRequest, chunks: ['never'] },
      ]),
    ).toThrow(new CannedProviderConfigError(`canned entry 0 has an invalid request: ${issue}`))
  })

  it('joins every invalid-request issue with a semicolon', () => {
    expect(() =>
      createCannedProvider([
        {
          request: { ...request(), provider: '', model: '' } as CompletionRequest,
          chunks: ['never'],
        },
      ]),
    ).toThrow(
      new CannedProviderConfigError(
        'canned entry 0 has an invalid request: provider: Too small: expected string to have >=1 characters; model: Too small: expected string to have >=1 characters',
      ),
    )
  })
})

describe('live provider surface', () => {
  it('reports the exact outage message and label', () => {
    const provider = createLiveProvider('m0-live-not-wired')

    expect(provider.kind).toBe('live')
    expect(provider.label).toBe('m0-live-not-wired')
    expect(provider.dispose).toBeUndefined()

    const thrown = capture(() => provider.complete(request()))

    expect(thrown).toBeInstanceOf(ProviderUnavailableError)
    if (!(thrown instanceof ProviderUnavailableError)) return
    expect(thrown.name).toBe('ProviderUnavailableError')
    expect(thrown.message).toBe(
      'live provider "m0-live-not-wired" is not wired at M0; no network call was made',
    )
    expect(thrown.providerLabel).toBe('m0-live-not-wired')
  })
})
