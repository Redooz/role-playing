import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createJevClient } from './client.js'
import {
  computeJevCacheKey,
  createFileJevCache,
  defaultJevCacheDir,
  type JevCacheKeyInput,
} from './cache.js'
import { JEV_CACHE_SCHEMA_VERSION, JEV_MODEL, JEV_PROVIDER_SURFACE } from './constants.js'
import { JevConfigError } from './errors.js'
import { declareJevJudgment } from './questions.js'
import type { JevJudgment, JevRequestPayload } from './types.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')

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
  graderVersion: JEV_MODEL,
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

    expect(computeJevCacheKey({ ...baseKeyInput, graderVersion: 'typesafe/jev-1.13' })).not.toBe(
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

  it('changes when the locale changes', () => {
    const key = computeJevCacheKey({ ...baseKeyInput, locale: 'en' })
    expect(computeJevCacheKey({ ...baseKeyInput, locale: 'en-GB' })).not.toBe(key)
    expect(computeJevCacheKey({ ...baseKeyInput, locale: 'fr-CA' })).not.toBe(key)
    expect(key).not.toBe(computeJevCacheKey(baseKeyInput))
  })

  it('hashes the canonical request and version stamps into one stable key', () => {
    expect(computeJevCacheKey(baseKeyInput)).toBe(
      '5740394aafb424dd39d1697c74eb5ea4e5d03330a470e9cfdd490468e1e1b32a',
    )
    expect(computeJevCacheKey({ ...baseKeyInput, locale: 'en-GB' })).toBe(
      '52ab151961a6b715b962f26a05ae1fa09b6bd695258060d71416210dbd95a135',
    )
  })
})

describe('defaultJevCacheDir', () => {
  it('points at the git-ignored evals cache at the repo root', () => {
    expect(defaultJevCacheDir()).toBe(join(repoRoot, 'evals/.cache'))
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

  it('rejects only keys that are exactly 64 lowercase hex characters', async () => {
    const cache = createFileJevCache({ directory })
    const key = computeJevCacheKey(baseKeyInput)

    for (const invalid of [
      `x${key}`,
      `${key}x`,
      key.toUpperCase(),
      key.slice(0, 63),
      `${key.slice(0, 62)}zz`,
    ]) {
      await expect(cache.read(invalid)).resolves.toBeUndefined()
      await expect(cache.write(invalid, rawResponse)).rejects.toThrow(
        new JevConfigError(`Invalid Jev cache key: ${JSON.stringify(invalid)}`),
      )
    }

    await expect(cache.write(key, rawResponse)).resolves.toBeUndefined()
  })

  it('trims the configured directory and rejects an empty or blank one', async () => {
    const trimmed = createFileJevCache({ directory: `  ${directory}  ` })
    expect(trimmed.directory).toBe(directory)
    const key = computeJevCacheKey(baseKeyInput)
    await trimmed.write(key, rawResponse)
    await expect(readdir(directory)).resolves.toEqual([`${key}.json`])

    expect(() => createFileJevCache({ directory: '' })).toThrow(
      new JevConfigError('Jev cache directory must be non-empty.'),
    )
    expect(() => createFileJevCache({ directory: '   ' })).toThrow(
      new JevConfigError('Jev cache directory must be non-empty.'),
    )
  })

  it('writes the exact envelope with a trailing newline', async () => {
    const cache = createFileJevCache({ directory })
    const key = computeJevCacheKey(baseKeyInput)
    await cache.write(key, rawResponse)

    const text = await readFile(join(directory, `${key}.json`), 'utf8')
    expect(text).toBe(
      `${JSON.stringify(
        {
          cacheSchemaVersion: JEV_CACHE_SCHEMA_VERSION,
          cacheKey: key,
          raw: rawResponse,
        },
        null,
        2,
      )}\n`,
    )
  })

  it('treats a wrong envelope version or a mismatched key as a miss', async () => {
    const cache = createFileJevCache({ directory })
    const key = computeJevCacheKey(baseKeyInput)

    await writeFile(
      join(directory, `${key}.json`),
      JSON.stringify({ cacheSchemaVersion: 2, cacheKey: key, raw: rawResponse }),
      'utf8',
    )
    await expect(cache.read(key)).resolves.toBeUndefined()

    await writeFile(
      join(directory, `${key}.json`),
      JSON.stringify({
        cacheSchemaVersion: JEV_CACHE_SCHEMA_VERSION,
        cacheKey: 'a'.repeat(64),
        raw: rawResponse,
      }),
      'utf8',
    )
    await expect(cache.read(key)).resolves.toBeUndefined()
  })

  it('removes the temp file and rethrows when the final rename fails', async () => {
    const cache = createFileJevCache({ directory })
    const key = computeJevCacheKey(baseKeyInput)
    await mkdir(join(directory, `${key}.json`))

    await expect(cache.write(key, rawResponse)).rejects.toThrow()
    await expect(readdir(directory)).resolves.toEqual([`${key}.json`])
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

    const first = await client.grade(judgment)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.error.message)
    expect(first.cache).toEqual({ key, hit: false, stored: true })
    expect(first.raw).toEqual(rawResponse)
    expect(calls).toHaveLength(1)
    await expect(readdir(directory)).resolves.toEqual([`${key}.json`])

    const second = await client.grade(judgment)
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error(second.error.message)
    expect(second.cache).toEqual({ key, hit: true, stored: false })
    expect(second.raw).toEqual(rawResponse)
    expect(calls).toHaveLength(1)
  })

  it('fetches every time when caching is disabled', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(rawResponse))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    await client.grade(judgment)
    await client.grade(judgment)

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

    await client.grade(judgment)
    await client.grade(otherJudgment)

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

    const result = await client.grade(judgment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.cache).toEqual({ key, hit: false, stored: true })
    expect(calls).toHaveLength(1)
  })
})
