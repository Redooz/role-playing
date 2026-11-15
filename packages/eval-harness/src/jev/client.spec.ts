import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { computeJevCacheKey } from './cache.js'
import type { JevCache } from './cache.js'
import { createJevClient } from './client.js'
import type { JevClientOptions } from './client.js'
import { JEV_ENDPOINT, JEV_MODEL, JEV_PROVIDER_SURFACE } from './constants.js'
import { JevConfigError, JevInvalidResponseError, JevUnavailableError } from './errors.js'
import { declareJevJudgment } from './questions.js'
import type { JevJudgment } from './types.js'

const QUESTION_ID = 'client-question'

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

function validResponse(noul = 0.73, model = 'typesafe/jev-1.14-20261014') {
  return {
    id: 'gen-test-client',
    model,
    provider: 'TypeSafe',
    answers: { [QUESTION_ID]: { type: 'noul', noul } },
    usage: { input_tokens: 12, output_tokens: 3, cost: 0.00001 },
    unknown_field: 'preserved in raw',
  }
}

const CHOICE_ID = 'choice-question'

const choiceJudgment: JevJudgment = declareJevJudgment({
  metadata: {
    id: CHOICE_ID,
    lang: 'en',
    rubricVersion: 'rubric-v1',
  },
  state: { utterance: 'Could you send me the file by Friday?' },
  question: {
    type: 'choice',
    instructions: 'Which register best describes the utterance?',
    criteria: {
      formal: 'A polite, hedged workplace register.',
      informal: 'A casual or blunt register.',
    },
  },
})

function choiceResponse(probabilities: Record<string, number>) {
  return {
    id: 'gen-test-choice',
    model: 'typesafe/jev-1.14-20261014',
    provider: 'TypeSafe',
    answers: {
      [CHOICE_ID]: {
        type: 'choice',
        choice: 'formal',
        probabilities,
        confidence: 0.6,
      },
    },
    usage: { input_tokens: 20, output_tokens: 5, cost: 0.00002 },
  }
}

const SCORE_ID = 'score-question'

const scoreJudgment: JevJudgment = declareJevJudgment({
  metadata: {
    id: SCORE_ID,
    lang: 'en',
    rubricVersion: 'rubric-v1',
  },
  state: { utterance: 'Could you possibly send me the file by Friday?' },
  question: {
    type: 'score',
    instructions: 'How clear is the request?',
    criteria: ['Hard to understand', 'Understandable but vague', 'Clear and specific'],
  },
})

function scoreResponse(probabilities: Record<string, number>) {
  return {
    id: 'gen-test-score',
    model: 'typesafe/jev-1.14-20261014',
    provider: 'TypeSafe',
    answers: {
      [SCORE_ID]: {
        type: 'score',
        score: 1.54,
        probabilities,
        confidence: 0.31,
        legend: {
          '0': 'Hard to understand',
          '1': 'Understandable but vague',
          '2': 'Clear and specific',
        },
      },
    },
    usage: { input_tokens: 30, output_tokens: 8, cost: 0.00003 },
  }
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

describe('Jev client pin enforcement', () => {
  it('accepts the default pin and the explicit pin', () => {
    expect(() => createJevClient({ apiKey: 'test', cache: false })).not.toThrow()
    expect(() => createJevClient({ apiKey: 'test', model: JEV_MODEL, cache: false })).not.toThrow()
  })

  it.each(['jev-latest', 'typesafe/jev-latest', 'typesafe/jev-1.13', 'openai/gpt-oss-20b'])(
    'throws for configured model %s',
    (model) => {
      expect(() => createJevClient({ apiKey: 'test', model, cache: false })).toThrow(JevConfigError)
    },
  )

  it('rejects an empty API key', () => {
    expect(() => createJevClient({ apiKey: '   ', cache: false })).toThrow(JevConfigError)
  })

  it('rejects an invalid timeout or provider surface', () => {
    expect(() => createJevClient({ apiKey: 'test', cache: false, timeoutMs: 0 })).toThrow(
      JevConfigError,
    )
    expect(() => createJevClient({ apiKey: 'test', cache: false, providerSurface: ' ' })).toThrow(
      JevConfigError,
    )
  })
})

describe('Jev client request shape', () => {
  it('sends exactly one question to the Decisions endpoint with the pinned model', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(validResponse()))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)
    expect(result.ok).toBe(true)

    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (call === undefined) throw new Error('expected a fetch call')

    expect(call.url).toBe(JEV_ENDPOINT)
    expect(call.init?.method).toBe('POST')
    const headers = new Headers(call.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer test-key')
    expect(headers.get('content-type')).toBe('application/json')

    const body = JSON.parse(String(call.init?.body)) as {
      model: string
      questions: Record<string, unknown>
    }
    expect(body.model).toBe(JEV_MODEL)
    expect(Object.keys(body.questions)).toEqual([QUESTION_ID])
  })

  it('rejects a per-call model override before making a request', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(validResponse()))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })
    const overridden = {
      ...judgment,
      model: 'typesafe/jev-1.13',
    } as JevJudgment

    const result = await client.grade(overridden)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevConfigError)
    expect(calls).toHaveLength(0)
  })

  it('rejects a different grader version in the judgment metadata', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(validResponse()))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })
    const otherGrader: JevJudgment = {
      ...judgment,
      metadata: { ...judgment.metadata, graderVersion: 'typesafe/jev-1.13' },
    }

    const result = await client.grade(otherGrader)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevConfigError)
    expect(calls).toHaveLength(0)
  })
})

describe('Jev client successful judgments', () => {
  it('returns the full raw response and both sides of the noul distribution', async () => {
    const raw = validResponse(0.73)
    const { fetchImpl } = recordingFetch(() => jsonResponse(raw))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)

    expect(result.questionId).toBe(QUESTION_ID)
    expect(result.raw).toEqual(raw)
    expect(result.response.model).toBe(raw.model)
    expect(result.servedModel).toBe(raw.model)
    expect(result.usage.cost).toBeCloseTo(0.00001)
    expect(result.cache.hit).toBe(false)

    expect(result.distribution.kind).toBe('noul')
    if (result.distribution.kind !== 'noul') throw new Error('expected a noul distribution')
    expect(result.distribution.probabilityYes).toBeCloseTo(0.73)
    expect(result.distribution.probabilityNo).toBeCloseTo(0.27)
  })

  it('accepts the exact pin as the served model', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(validResponse(0.5, JEV_MODEL)))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.servedModel).toBe(JEV_MODEL)
  })

  it('returns the full choice probability map, not just the argmax', async () => {
    const raw = choiceResponse({ formal: 0.8, informal: 0.2 })
    const { fetchImpl } = recordingFetch(() => jsonResponse(raw))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(choiceJudgment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)

    expect(result.distribution.kind).toBe('choice')
    if (result.distribution.kind !== 'choice') throw new Error('expected a choice distribution')
    expect(result.distribution.choice).toBe('formal')
    expect(result.distribution.probabilities).toEqual({ formal: 0.8, informal: 0.2 })
    expect(result.distribution.confidence).toBeCloseTo(0.6)
  })

  it('returns the full score probability map and legend', async () => {
    const raw = scoreResponse({ '0': 0, '1': 0.46, '2': 0.54 })
    const { fetchImpl } = recordingFetch(() => jsonResponse(raw))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(scoreJudgment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)

    expect(result.distribution.kind).toBe('score')
    if (result.distribution.kind !== 'score') throw new Error('expected a score distribution')
    expect(result.distribution.score).toBeCloseTo(1.54)
    expect(result.distribution.probabilities).toEqual({ '0': 0, '1': 0.46, '2': 0.54 })
    expect(result.distribution.legend).toEqual({
      '0': 'Hard to understand',
      '1': 'Understandable but vague',
      '2': 'Clear and specific',
    })
  })

  it('survives read and write cache failures without changing the judgment', async () => {
    const failingCache: JevCache = {
      directory: '/definitely/not/writable',
      read: async () => {
        throw new Error('read failed')
      },
      write: async () => {
        throw new Error('write failed')
      },
    }
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(validResponse()))
    const client = createJevClient({
      apiKey: 'test-key',
      fetchImpl,
      cache: failingCache,
    })

    const result = await client.grade(judgment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.distribution.kind).toBe('noul')
    expect(result.cache.hit).toBe(false)
    expect(result.cache.stored).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

describe('Jev client failure semantics', () => {
  it('returns a typed unavailable error for non-2xx and no distribution', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ error: { code: 500, message: 'upstream failed' } }, 500),
    )
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevUnavailableError)
    if (result.error instanceof JevUnavailableError) {
      expect(result.error.reason).toBe('http')
      expect(result.error.status).toBe(500)
    }
    expect(result).not.toHaveProperty('distribution')
    expect(result).not.toHaveProperty('servedModel')
  })

  it('returns a typed unavailable error for a transport failure', async () => {
    const { fetchImpl } = recordingFetch(() => {
      throw new Error('ECONNREFUSED')
    })
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevUnavailableError)
    if (result.error instanceof JevUnavailableError) {
      expect(result.error.reason).toBe('network')
    }
    expect(result).not.toHaveProperty('distribution')
  })

  it('rejects a malformed JSON body', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('this is not json', { status: 200 }))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
  })

  it('rejects a missing distribution', async () => {
    const broken = {
      ...validResponse(),
      answers: { [QUESTION_ID]: { type: 'noul' } },
    }
    const { fetchImpl } = recordingFetch(() => jsonResponse(broken))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
    if (result.error instanceof JevInvalidResponseError) {
      expect(result.error.details.join(' ')).toMatch(/noul/)
    }
  })

  it('rejects an out-of-range probability', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(validResponse(1.5)))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
  })

  it('rejects a response from a different model', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(validResponse(0.5, 'typesafe/jev-1.13-20260917')),
    )
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
  })

  it('rejects a missing answer', async () => {
    const broken = {
      ...validResponse(),
      answers: { another_question: { type: 'noul', noul: 0.5 } },
    }
    const { fetchImpl } = recordingFetch(() => jsonResponse(broken))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
  })

  it('rejects extra answers', async () => {
    const broken = {
      ...validResponse(),
      answers: {
        [QUESTION_ID]: { type: 'noul', noul: 0.5 },
        another_question: { type: 'noul', noul: 0.5 },
      },
    }
    const { fetchImpl } = recordingFetch(() => jsonResponse(broken))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
  })

  it('rejects an answer type mismatch', async () => {
    const broken = {
      ...validResponse(),
      answers: {
        [QUESTION_ID]: {
          type: 'choice',
          choice: 'formal',
          probabilities: { formal: 1 },
        },
      },
    }
    const { fetchImpl } = recordingFetch(() => jsonResponse(broken))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
  })

  it('rejects an incomplete choice distribution', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(choiceResponse({ formal: 1 })))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(choiceJudgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
  })

  it('rejects a distribution that does not sum to one', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(choiceResponse({ formal: 0.5, informal: 0.2 })),
    )
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(choiceJudgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
    if (result.error instanceof JevInvalidResponseError) {
      expect(result.error.message).toMatch(/sum to/)
    }
  })
})

const unkeyableJudgment: JevJudgment = {
  metadata: judgment.metadata,
  // A BigInt passes the state schema but the canonical JSON codec cannot encode it.
  state: { utterance: 'Please send the report by Friday.', attempt: 1n },
  question: judgment.question,
}

function configErrorFrom(options: JevClientOptions): JevConfigError {
  try {
    createJevClient(options)
  } catch (error) {
    if (error instanceof JevConfigError) return error
    throw error
  }
  throw new Error('expected createJevClient to reject the configuration')
}

function expectedCacheKey(
  input: {
    readonly judgment?: JevJudgment
    readonly providerSurface?: string
    readonly locale?: string
  } = {},
): string {
  const source = input.judgment ?? judgment
  return computeJevCacheKey({
    request: {
      model: JEV_MODEL,
      state: source.state,
      questions: { [source.metadata.id]: source.question },
    },
    graderVersion: source.metadata.graderVersion,
    rubricVersion: source.metadata.rubricVersion,
    extractionVersion: source.metadata.extractionVersion,
    providerSurface: input.providerSurface ?? JEV_PROVIDER_SURFACE,
    ...(input.locale === undefined ? {} : { locale: input.locale }),
  })
}

function responseWhoseBodyThrows(status: number, error: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => {
      throw error
    },
  } as unknown as Response
}

describe('Jev client configuration messages', () => {
  it('names the missing API key', () => {
    const error = configErrorFrom({ apiKey: '' })

    expect(error.code).toBe('jev_config')
    expect(error.message).toBe('A non-empty OpenRouter API key is required.')
  })

  it('names the pinned model when another model is configured', () => {
    const error = configErrorFrom({ apiKey: 'test', model: 'typesafe/jev-latest', cache: false })

    expect(error.message).toBe(
      'Jev is pinned to typesafe/jev-1.14; refusing configured model "typesafe/jev-latest".',
    )
  })

  it('names the empty provider surface', () => {
    const error = configErrorFrom({ apiKey: 'test', cache: false, providerSurface: '   ' })

    expect(error.message).toBe('The Jev provider surface must be non-empty.')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1])(
    'rejects the timeout %s',
    (timeoutMs) => {
      const error = configErrorFrom({ apiKey: 'test', cache: false, timeoutMs })

      expect(error.message).toBe('Jev timeout must be a positive number of milliseconds.')
    },
  )

  it('accepts a positive timeout and exposes the pin and default surface', () => {
    const client = createJevClient({ apiKey: 'test', cache: false, timeoutMs: 1 })

    expect(client.model).toBe(JEV_MODEL)
    expect(client.providerSurface).toBe(JEV_PROVIDER_SURFACE)
  })

  it('uses the global fetch when no fetch implementation is injected', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(validResponse()))
    try {
      const client = createJevClient({ apiKey: 'test-key', cache: false })

      const result = await client.grade(judgment)

      expect(result.ok).toBe(true)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('stores and replays one judgment through the built-in file cache', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jev-client-cache-'))
    try {
      const { fetchImpl, calls } = recordingFetch(() => jsonResponse(validResponse()))
      const client = createJevClient({ apiKey: 'test-key', fetchImpl, cacheDir: directory })

      const first = await client.grade(judgment)
      expect(first.ok).toBe(true)
      if (!first.ok) throw new Error(first.error.message)
      expect(first.cache).toEqual({ key: expectedCacheKey(), hit: false, stored: true })

      const second = await client.grade(judgment)
      expect(second.ok).toBe(true)
      if (!second.ok) throw new Error(second.error.message)
      expect(second.cache).toEqual({ key: expectedCacheKey(), hit: true, stored: false })
      expect(second.distribution).toEqual(first.distribution)
      expect(calls).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not reuse a judgment when the cache is disabled', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(validResponse()))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    await client.grade(judgment)
    await client.grade(judgment)

    expect(calls).toHaveLength(2)
  })
})

describe('Jev client cache keys', () => {
  it('derives the key from the request, the version stamps and the default surface', () => {
    const client = createJevClient({ apiKey: 'test', cache: false })

    expect(client.cacheKeyFor(judgment)).toBe(expectedCacheKey())
  })

  it('changes the key with the provider surface', () => {
    const surface = 'openrouter/api/alpha/decisions-v2'
    const client = createJevClient({ apiKey: 'test', cache: false, providerSurface: surface })

    expect(client.providerSurface).toBe(surface)
    expect(client.cacheKeyFor(judgment)).toBe(expectedCacheKey({ providerSurface: surface }))
    expect(client.cacheKeyFor(judgment)).not.toBe(expectedCacheKey())
  })

  it('includes the optional locale and omits it when absent', () => {
    const localized: JevJudgment = declareJevJudgment({
      metadata: {
        id: 'localized-question',
        lang: 'en',
        locale: 'en-GB',
        rubricVersion: 'rubric-v1',
      },
      state: judgment.state,
      question: judgment.question,
    })
    const client = createJevClient({ apiKey: 'test', cache: false })

    expect(client.cacheKeyFor(localized)).toBe(
      expectedCacheKey({ judgment: localized, locale: 'en-GB' }),
    )
    expect(client.cacheKeyFor(localized)).not.toBe(expectedCacheKey({ judgment: localized }))
  })

  it('changes the key with the state', () => {
    const client = createJevClient({ apiKey: 'test', cache: false })
    const other: JevJudgment = {
      ...judgment,
      state: { utterance: 'Please send the report by Monday.' },
    }

    expect(client.cacheKeyFor(other)).not.toBe(client.cacheKeyFor(judgment))
  })

  it('fails as a configuration error when the cache key cannot be computed', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(validResponse()))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(unkeyableJudgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.questionId).toBe(QUESTION_ID)
    expect(result.error).toBeInstanceOf(JevConfigError)
    if (!(result.error instanceof JevConfigError)) throw new Error('expected a configuration error')
    expect(result.error.message).toBe('Could not compute the Jev cache key.')
    expect(result.error.cause).toBeInstanceOf(TypeError)
    expect(result.cache).toEqual({ key: null, hit: false, stored: false })
    expect(calls).toHaveLength(0)
  })
})

describe('Jev client request serialization guard', () => {
  it('fails as a configuration error when the request body cannot be serialized', async () => {
    // The cache key uses the canonical JSON codec, which ignores inherited
    // `toJSON` hooks; the request body uses JSON.stringify, which calls them.
    const cause = new Error('cannot encode this state')
    const hostile = Object.create({
      toJSON: () => {
        throw cause
      },
    }) as Record<string, unknown>
    const hostileJudgment: JevJudgment = {
      metadata: judgment.metadata,
      state: [hostile],
      question: judgment.question,
    }
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(validResponse()))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(hostileJudgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevConfigError)
    if (!(result.error instanceof JevConfigError)) throw new Error('expected a configuration error')
    expect(result.error.message).toBe('The Jev request is not JSON-serializable.')
    expect(result.error.cause).toBe(cause)
    expect(result.cache).toEqual({
      key: expectedCacheKey({ judgment: hostileJudgment }),
      hit: false,
      stored: false,
    })
    expect(calls).toHaveLength(0)
  })
})

describe('Jev client request body', () => {
  it('sends the Accept header, the exact payload and a timeout signal', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(validResponse()))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)
    expect(result.ok).toBe(true)

    const call = calls[0]
    if (call === undefined) throw new Error('expected a fetch call')
    expect(call.url).toBe(JEV_ENDPOINT)
    const headers = new Headers(call.init?.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(call.init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(call.init?.body))).toEqual({
      model: JEV_MODEL,
      state: judgment.state,
      questions: { [QUESTION_ID]: judgment.question },
    })
  })
})

describe('Jev client model override guard', () => {
  it('names the fixed model and sends nothing for a single-question override', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(validResponse()))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade({
      ...judgment,
      model: 'typesafe/jev-latest',
    } as JevJudgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.questionId).toBe(QUESTION_ID)
    expect(result.error).toBeInstanceOf(JevConfigError)
    if (!(result.error instanceof JevConfigError)) throw new Error('expected a configuration error')
    expect(result.error.message).toBe(
      'Jev model is fixed at typesafe/jev-1.14; per-call model overrides are not accepted.',
    )
    expect(result.cache).toEqual({ key: null, hit: false, stored: false })
    expect(calls).toHaveLength(0)
  })
})

describe('Jev client HTTP failure detail', () => {
  it('reports the trimmed upstream detail and the cache status', async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response('  upstream blew up \n', { status: 400 }),
    )
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevUnavailableError)
    if (!(result.error instanceof JevUnavailableError)) {
      throw new Error('expected an unavailable error')
    }
    expect(result.error.reason).toBe('http')
    expect(result.error.status).toBe(400)
    expect(result.error.message).toBe('Jev request failed with HTTP 400: upstream blew up')
    expect(result.cache).toEqual({ key: expectedCacheKey(), hit: false, stored: false })
  })

  it('omits the detail suffix when the error body is empty', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('  \n', { status: 429 }))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    if (!(result.error instanceof JevUnavailableError)) {
      throw new Error('expected an unavailable error')
    }
    expect(result.error.status).toBe(429)
    expect(result.error.message).toBe('Jev request failed with HTTP 429')
  })

  it('truncates an over-long error detail at 300 characters', async () => {
    const detail = 'x'.repeat(400)
    const { fetchImpl } = recordingFetch(() => new Response(detail, { status: 502 }))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error.message).toBe(`Jev request failed with HTTP 502: ${'x'.repeat(300)}…`)
  })

  it('keeps an error detail of exactly 300 characters', async () => {
    const detail = 'y'.repeat(300)
    const { fetchImpl } = recordingFetch(() => new Response(detail, { status: 502 }))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error.message).toBe(`Jev request failed with HTTP 502: ${detail}`)
  })

  it('reports the status when the error body cannot be read', async () => {
    const { fetchImpl } = recordingFetch(() =>
      responseWhoseBodyThrows(500, new Error('socket closed')),
    )
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    if (!(result.error instanceof JevUnavailableError)) {
      throw new Error('expected an unavailable error')
    }
    expect(result.error.reason).toBe('http')
    expect(result.error.status).toBe(500)
    expect(result.error.message).toBe('Jev request failed with HTTP 500')
  })
})

describe('Jev client unreadable success body', () => {
  it('fails as a network error when the success body cannot be read', async () => {
    const cause = new Error('socket closed')
    const { fetchImpl } = recordingFetch(() => responseWhoseBodyThrows(200, cause))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevUnavailableError)
    if (!(result.error instanceof JevUnavailableError)) {
      throw new Error('expected an unavailable error')
    }
    expect(result.error.reason).toBe('network')
    expect(result.error.message).toBe('Could not read the Jev response body.')
    expect(result.error.cause).toBe(cause)
    expect(result.cache).toEqual({ key: expectedCacheKey(), hit: false, stored: false })
    expect(result).not.toHaveProperty('distribution')
  })
})

describe('Jev client invalid JSON detail', () => {
  it('reports the body length in the invalid JSON details', async () => {
    const body = 'this is not json'
    const { fetchImpl } = recordingFetch(() => new Response(body, { status: 200 }))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
    if (!(result.error instanceof JevInvalidResponseError)) {
      throw new Error('expected an invalid response error')
    }
    expect(result.error.message).toBe('Jev response was not valid JSON.')
    expect(result.error.details).toEqual([`body length: ${body.length}`])
  })
})

describe('Jev client transport failure mapping', () => {
  it('maps an AbortError to a timeout', async () => {
    const cause = new Error('The operation was aborted')
    cause.name = 'AbortError'
    const { fetchImpl } = recordingFetch(() => {
      throw cause
    })
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    if (!(result.error instanceof JevUnavailableError)) {
      throw new Error('expected an unavailable error')
    }
    expect(result.error.reason).toBe('timeout')
    expect(result.error.status).toBeUndefined()
    expect(result.error.message).toBe('Jev request timed out before a response arrived.')
    expect(result.error.cause).toBe(cause)
  })

  it('maps a TimeoutError to a timeout', async () => {
    const cause = new Error('The operation timed out')
    cause.name = 'TimeoutError'
    const { fetchImpl } = recordingFetch(() => {
      throw cause
    })
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    if (!(result.error instanceof JevUnavailableError)) {
      throw new Error('expected an unavailable error')
    }
    expect(result.error.reason).toBe('timeout')
    expect(result.error.message).toBe('Jev request timed out before a response arrived.')
    expect(result.error.cause).toBe(cause)
  })

  it('keeps the message of a plain Error as the network detail', async () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:443')
    const { fetchImpl } = recordingFetch(() => {
      throw cause
    })
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    if (!(result.error instanceof JevUnavailableError)) {
      throw new Error('expected an unavailable error')
    }
    expect(result.error.reason).toBe('network')
    expect(result.error.message).toBe(
      'Jev request failed before a response arrived: connect ECONNREFUSED 127.0.0.1:443',
    )
    expect(result.error.cause).toBe(cause)
  })

  it('omits the detail for a non-Error throw', async () => {
    const thrown: unknown = { code: 'socket_closed' }
    const { fetchImpl } = recordingFetch(() => {
      throw thrown
    })
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.grade(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    if (!(result.error instanceof JevUnavailableError)) {
      throw new Error('expected an unavailable error')
    }
    expect(result.error.reason).toBe('network')
    expect(result.error.message).toBe('Jev request failed before a response arrived')
    expect(result.error.cause).toBe(thrown)
  })
})

describe('Jev client judgment guards', () => {
  const invalidJudgments: readonly { readonly label: string; readonly input: unknown }[] = [
    { label: 'a null judgment', input: null },
    { label: 'an undefined judgment', input: undefined },
    { label: 'a string judgment', input: 'not a judgment' },
    {
      label: 'a judgment without metadata',
      input: { state: { utterance: 'Hello.' }, question: judgment.question },
    },
    {
      label: 'a judgment with null metadata',
      input: { metadata: null, state: { utterance: 'Hello.' }, question: judgment.question },
    },
    {
      label: 'a judgment with string metadata',
      input: { metadata: QUESTION_ID, state: { utterance: 'Hello.' }, question: judgment.question },
    },
    {
      label: 'a judgment with a numeric id',
      input: {
        metadata: { ...judgment.metadata, id: 42 },
        state: { utterance: 'Hello.' },
        question: judgment.question,
      },
    },
  ]

  it.each(invalidJudgments)(
    'returns an empty question id and a typed failure for $label',
    async ({ input }) => {
      const client = createJevClient({ apiKey: 'test-key', cache: false })

      const result = await client.grade(input as JevJudgment)

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a failure')
      expect(result.questionId).toBe('')
      expect(result.error).toBeInstanceOf(JevConfigError)
      if (!(result.error instanceof JevConfigError)) {
        throw new Error('expected a configuration error')
      }
      expect(result.error.message).toBe('Invalid Jev judgment.')
      expect(result.error.details.length).toBeGreaterThan(0)
      expect(result.cache).toEqual({ key: null, hit: false, stored: false })
    },
  )
})
