import { describe, expect, it } from 'vitest'
import type { JevCache } from './cache.js'
import { createJevClient } from './client.js'
import { JEV_ENDPOINT, JEV_MODEL } from './constants.js'
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

    const result = await client.judge(judgment)
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

    const result = await client.judge(overridden)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevConfigError)
    expect(calls).toHaveLength(0)
  })

  it('rejects a different scorer version in the judgment metadata', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(validResponse()))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })
    const otherScorer: JevJudgment = {
      ...judgment,
      metadata: { ...judgment.metadata, scorerVersion: 'typesafe/jev-1.13' },
    }

    const result = await client.judge(otherScorer)

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

    const result = await client.judge(judgment)
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

    const result = await client.judge(judgment)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.servedModel).toBe(JEV_MODEL)
  })

  it('returns the full choice probability map, not just the argmax', async () => {
    const raw = choiceResponse({ formal: 0.8, informal: 0.2 })
    const { fetchImpl } = recordingFetch(() => jsonResponse(raw))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.judge(choiceJudgment)
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

    const result = await client.judge(scoreJudgment)
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

    const result = await client.judge(judgment)
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

    const result = await client.judge(judgment)

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

    const result = await client.judge(judgment)

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

    const result = await client.judge(judgment)

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

    const result = await client.judge(judgment)

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

    const result = await client.judge(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
  })

  it('rejects a response from a different model', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(validResponse(0.5, 'typesafe/jev-1.13-20260917')),
    )
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.judge(judgment)

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

    const result = await client.judge(judgment)

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

    const result = await client.judge(judgment)

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

    const result = await client.judge(judgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
  })

  it('rejects an incomplete choice distribution', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(choiceResponse({ formal: 1 })))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.judge(choiceJudgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
  })

  it('rejects a distribution that does not sum to one', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(choiceResponse({ formal: 0.5, informal: 0.2 })),
    )
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })

    const result = await client.judge(choiceJudgment)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
    if (result.error instanceof JevInvalidResponseError) {
      expect(result.error.message).toMatch(/sum to/)
    }
  })
})
