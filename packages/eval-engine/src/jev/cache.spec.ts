import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createJevClient } from './client.js'
import { computeJevCacheKey, createFileJevCache, type JevCacheKeyInput } from './cache.js'
import { JEV_CACHE_SCHEMA_VERSION, JEV_MODEL, JEV_PROVIDER_SURFACE } from './constants.js'
import { JevConfigError } from './errors.js'
import { declareJevJudgment } from './questions.js'
import type { JevJudgment, JevRequestPayload } from './types.js'

const QUESTION_ID = 'cache-question'

const judgment: JevJudgment = declareJevJudgment({
  metadata: {
    id: QUESTION_ID,
    lang: 'en',
    rubricVersion: 'rubric-v1',
  },
  state: { utterance: 'Please send the report by Friday.' },
  question: {
    type: 'noul',
    instructions: 'Is this a request?',
    criteria: {
      true: 'The utterance asks for something.',
      false: 'The utterance does not ask for anything.',
    },
  },
})

const rawResponse = {
  id: 'gen-test-cache',
  model: 'typesafe/jev-1.14-20261014',
  provider: 'TypeSafe',
  answers: { [QUESTION_ID]: { type: 'noul', noul: 0.81 } },
  usage: { input_tokens: 12, output_tokens: 3, cost: 0.00001 },
}

interface RecordedCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

function recordingFetch(handler: (call: RecordedCall) => Response | Promise<Response>): {
  fetchImpl: typeof fetch
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const call = { url, init }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  return { fetchImpl, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const requestA = {
  model: JEV_MODEL,
  state: { b: 2, a: 1 },
  questions: {
    q: {
      type: 'noul',
      instructions: 'Is this a request?',
      criteria: { true: 'Yes.', false: 'No.' },
    },
  },
} satisfies JevRequestPayload

const requestB = {
  questions: {
    q: {
      criteria: { false: 'No.', true: 'Yes.' },
      instructions: 'Is this a request?',
      type: 'noul',
    },
  },
  state: { a: 1, b: 2 },
  model: JEV_MODEL,
} satisfies JevRequestPayload

const baseKeyInput: JevCacheKeyInput = {
  request: requestA,
  scorerVersion: JEV_MODEL,
  rubricVersion: 'rubric-v1',
  extractionVersion: 'none',
  providerSurface: JEV_PROVIDER_SURFACE,
}

describe('computeJevCacheKey', () => {
  it('is stable across key insertion order', () => {
    expect(computeJevCacheKey(baseKeyInput)).toBe(
      computeJevCacheKey({ ...baseKeyInput, request: requestB }),
    )
  })

  it('changes when any version input or the payload changes', () => {
    const key = computeJevCacheKey(baseKeyInput)

    expect(computeJevCacheKey({ ...baseKeyInput, scorerVersion: 'typesafe/jev-1.13' })).not.toBe(
      key,
    )
    expect(computeJevCacheKey({ ...baseKeyInput, rubricVersion: 'rubric-v2' })).not.toBe(key)
    expect(computeJevCacheKey({ ...baseKeyInput, extractionVersion: 'extractor-v2' })).not.toBe(key)
    expect(computeJevCacheKey({ ...baseKeyInput, providerSurface: 'another-surface' })).not.toBe(
      key,
    )
    expect(
      computeJevCacheKey({
        ...baseKeyInput,
        request: { ...requestA, state: { a: 2, b: 1 } },
      }),
    ).not.toBe(key)
  })
})

describe('createFileJevCache', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'jev-cache-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('round-trips the full raw response and leaves no temp file', async () => {
    const cache = createFileJevCache({ directory })
    const key = computeJevCacheKey(baseKeyInput)

    await cache.write(key, rawResponse)

    await expect(cache.read(key)).resolves.toEqual(rawResponse)
    await expect(readdir(directory)).resolves.toEqual([`${key}.json`])

    const entry = JSON.parse(await readFile(join(directory, `${key}.json`), 'utf8')) as {
      cacheSchemaVersion: number
      cacheKey: string
      raw: unknown
    }
    expect(entry.cacheSchemaVersion).toBe(JEV_CACHE_SCHEMA_VERSION)
    expect(entry.cacheKey).toBe(key)
    expect(entry.raw).toEqual(rawResponse)
  })

  it('treats missing and corrupt entries as misses', async () => {
    const cache = createFileJevCache({ directory })
    const key = computeJevCacheKey(baseKeyInput)

    await expect(cache.read(key)).resolves.toBeUndefined()

    await writeFile(join(directory, `${key}.json`), 'not json', 'utf8')
    await expect(cache.read(key)).resolves.toBeUndefined()
  })

  it('refuses keys that are not SHA-256 hex', async () => {
    const cache = createFileJevCache({ directory })

    await expect(cache.read('../escape')).resolves.toBeUndefined()
    await expect(cache.write('../escape', rawResponse)).rejects.toThrow(JevConfigError)
  })
})

describe('Jev client cache integration', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'jev-cache-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('misses, writes, then serves later calls from the cache without a second fetch', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(rawResponse))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cacheDir: directory })
    const key = client.cacheKeyFor(judgment)

    const first = await client.judge(judgment)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.error.message)
    expect(first.cache).toEqual({ key, hit: false, stored: true })
    expect(first.raw).toEqual(rawResponse)
    expect(calls).toHaveLength(1)
    await expect(readdir(directory)).resolves.toEqual([`${key}.json`])

    const second = await client.judge(judgment)
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error(second.error.message)
    expect(second.cache).toEqual({ key, hit: true, stored: false })
    expect(second.raw).toEqual(rawResponse)
    expect(calls).toHaveLength(1)
  })

  it('fetches every time when caching is disabled', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(rawResponse))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    await client.judge(judgment)
    await client.judge(judgment)

    expect(calls).toHaveLength(2)
  })

  it('uses a new key and a new network call when the rubric version changes', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(rawResponse))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cacheDir: directory })
    const otherJudgment: JevJudgment = {
      ...judgment,
      metadata: { ...judgment.metadata, rubricVersion: 'rubric-v2' },
    }

    expect(client.cacheKeyFor(otherJudgment)).not.toBe(client.cacheKeyFor(judgment))

    await client.judge(judgment)
    await client.judge(otherJudgment)

    expect(calls).toHaveLength(2)
    await expect(readdir(directory)).resolves.toHaveLength(2)
  })

  it('treats a corrupt entry as a miss and refetches', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(rawResponse))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cacheDir: directory })
    const key = client.cacheKeyFor(judgment)

    await writeFile(
      join(directory, `${key}.json`),
      JSON.stringify({
        cacheSchemaVersion: JEV_CACHE_SCHEMA_VERSION,
        cacheKey: key,
        raw: { model: 'typesafe/jev-1.13-20260917' },
      }),
      'utf8',
    )

    const result = await client.judge(judgment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.cache).toEqual({ key, hit: false, stored: true })
    expect(calls).toHaveLength(1)
  })
})
