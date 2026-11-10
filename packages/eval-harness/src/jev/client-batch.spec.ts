import { describe, expect, it } from 'vitest'
import type { JevCache } from './cache.js'
import { createJevClient } from './client.js'
import { JEV_ENDPOINT } from './constants.js'
import { JevConfigError, JevInvalidResponseError, JevUnavailableError } from './errors.js'
import { declareJevBatchJudgment, declareJevJudgment } from './questions.js'
import { CENTRAL_CONTRIBUTION_QUESTION_ID, CENTRAL_SPEAKER_QUESTION_ID } from './routing.js'
import type { JevBatchJudgment } from './types.js'

const judgment: JevBatchJudgment = declareJevBatchJudgment({
  metadata: {
    id: 'batch-routing-test',
    lang: 'en',
    rubricVersion: 'routing-v1',
  },
  state: { utterance: 'Sam, can you confirm the handoff?' },
  questions: {
    [CENTRAL_CONTRIBUTION_QUESTION_ID]: {
      type: 'noul',
      instructions: 'Does anyone have a contribution?',
      criteria: { true: 'Yes.', false: 'No.' },
    },
    [CENTRAL_SPEAKER_QUESTION_ID]: {
      type: 'choice',
      instructions: 'Who should speak next?',
      criteria: { manager: 'The manager.', peer: 'The peer.' },
    },
  },
})

function response() {
  return {
    id: 'gen-batch',
    model: 'typesafe/jev-1.14-20261014',
    provider: 'TypeSafe',
    answers: {
      [CENTRAL_CONTRIBUTION_QUESTION_ID]: { type: 'noul', noul: 0.91 },
      [CENTRAL_SPEAKER_QUESTION_ID]: {
        type: 'choice',
        choice: 'peer',
        probabilities: { manager: 0.1, peer: 0.9 },
      },
    },
    usage: { input_tokens: 100, output_tokens: 10, cost: 0.0001 },
    unknown_field: 'kept in raw',
  }
}

function recordingFetch(handler: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler()
  }) as typeof fetch
  return { calls, fetchImpl }
}

describe('JevClient.decideMany', () => {
  it('sends every question in one request and returns every distribution', async () => {
    const { calls, fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify(response()), { status: 200 }),
    )
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })
    const result = await client.decideMany(judgment)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(JEV_ENDPOINT)
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      state: unknown
      questions: Record<string, unknown>
    }
    expect(body.state).toEqual(judgment.state)
    expect(Object.keys(body.questions).sort()).toEqual(
      [CENTRAL_CONTRIBUTION_QUESTION_ID, CENTRAL_SPEAKER_QUESTION_ID].sort(),
    )
    expect(result.questionIds).toEqual([
      CENTRAL_CONTRIBUTION_QUESTION_ID,
      CENTRAL_SPEAKER_QUESTION_ID,
    ])
    expect(result.distributions[CENTRAL_CONTRIBUTION_QUESTION_ID]).toMatchObject({
      kind: 'noul',
      probabilityYes: 0.91,
    })
    expect(result.distributions[CENTRAL_CONTRIBUTION_QUESTION_ID]).toHaveProperty(
      'probabilityNo',
      expect.closeTo(0.09, 10),
    )
    expect(result.distributions[CENTRAL_SPEAKER_QUESTION_ID]).toMatchObject({
      kind: 'choice',
      choice: 'peer',
    })
    expect(result.raw).toMatchObject({ unknown_field: 'kept in raw' })
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 10, cost: 0.0001 })
  })

  it('writes and reuses one cache entry for the whole batch', async () => {
    const entries = new Map<string, unknown>()
    const cache: JevCache = {
      directory: 'memory',
      async read(key) {
        return entries.get(key)
      },
      async write(key, raw) {
        entries.set(key, raw)
      },
    }
    const { calls, fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify(response()), { status: 200 }),
    )
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache })

    const first = await client.decideMany(judgment)
    const second = await client.decideMany(judgment)
    expect(first.ok && first.cache.stored).toBe(true)
    expect(second.ok && second.cache.hit).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('rejects a partial batch response', async () => {
    const partial = response()
    delete (partial.answers as Partial<typeof partial.answers>)[CENTRAL_SPEAKER_QUESTION_ID]
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify(partial), { status: 200 }),
    )
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })
    const result = await client.decideMany(judgment)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
  })

  it('rejects an extra answer in a batch response', async () => {
    const extra = response()
    ;(extra.answers as Record<string, unknown>).extra = { type: 'noul', noul: 0.5 }
    const { fetchImpl } = recordingFetch(() => new Response(JSON.stringify(extra), { status: 200 }))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })
    const result = await client.decideMany(judgment)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBeInstanceOf(JevInvalidResponseError)
  })

  it('returns a typed HTTP failure', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('rate limited', { status: 429 }))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })
    const result = await client.decideMany(judgment)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBeInstanceOf(JevUnavailableError)
    expect((result.error as JevUnavailableError).reason).toBe('http')
  })

  it('rejects a per-call model override', async () => {
    const client = createJevClient({ apiKey: 'test-key', cache: false })
    const result = await client.decideMany({
      ...judgment,
      model: 'jev-latest',
    } as unknown as JevBatchJudgment)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBeInstanceOf(JevConfigError)
  })

  it('rejects a batch with only one question', async () => {
    const client = createJevClient({ apiKey: 'test-key', cache: false })
    const result = await client.decideMany({
      ...judgment,
      questions: {
        [CENTRAL_CONTRIBUTION_QUESTION_ID]: judgment.questions[CENTRAL_CONTRIBUTION_QUESTION_ID]!,
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBeInstanceOf(JevConfigError)
  })

  it('keeps a single-question failure in the single-question shape', async () => {
    const single = declareJevJudgment({
      metadata: { id: 'single-failure', lang: 'en', rubricVersion: 'routing-v1' },
      state: { utterance: 'Hello.' },
      question: {
        type: 'noul',
        instructions: 'Is this a greeting?',
        criteria: { true: 'It greets.', false: 'It does not greet.' },
      },
    })
    const { fetchImpl } = recordingFetch(() => new Response('down', { status: 503 }))
    const client = createJevClient({ apiKey: 'test-key', fetchImpl, cache: false })
    const result = await client.grade(single)
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('questionIds')
    if (result.ok) return
    expect(result.questionId).toBe('single-failure')
    expect(result.error).toBeInstanceOf(JevUnavailableError)
  })

  it('rejects a choice with only one option', async () => {
    const client = createJevClient({ apiKey: 'test-key', cache: false })
    const result = await client.decideMany({
      ...judgment,
      questions: {
        ...judgment.questions,
        [CENTRAL_SPEAKER_QUESTION_ID]: {
          type: 'choice',
          instructions: 'Who?',
          criteria: { peer: 'Only one.' },
        },
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBeInstanceOf(JevConfigError)
  })
})
