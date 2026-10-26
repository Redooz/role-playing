import { describe, expect, it } from 'vitest'
import {
  CannedProviderConfigError,
  CannedProviderMissError,
  ProviderUnavailableError,
  cannedRequestHash,
  createCannedProvider,
  createLiveProvider,
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
