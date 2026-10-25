import { describe, expect, it } from 'vitest'
import { createJevClient } from './client.js'
import { JEV_MODEL } from './constants.js'
import {
  SMOKE_EN_QUESTION_ID,
  SMOKE_FR_QUESTION_ID,
  SMOKE_UNSETTLED_QUESTION_ID,
} from './questions.js'
import { assertJevSmokeSuite, runJevSmokeSuite } from './smoke-suite.js'

interface SmokeFetchOptions {
  readonly probabilities?: Readonly<Record<string, number>>
  readonly failQuestionId?: string
  readonly model?: string
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function smokeFetch(options: SmokeFetchOptions = {}): typeof fetch {
  const probabilities = options.probabilities ?? {}
  const model = options.model ?? 'typesafe/jev-1.14-20261014'
  const failQuestionId = options.failQuestionId

  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      questions: Record<string, unknown>
    }
    const questionId = Object.keys(body.questions)[0]
    if (questionId === undefined) throw new Error('request contained no question')

    if (questionId === failQuestionId) {
      return jsonResponse({ error: { code: 500, message: 'provider down' } }, 500)
    }

    const noul = probabilities[questionId] ?? 0.5
    return jsonResponse({
      id: 'gen-test-smoke',
      model,
      provider: 'TypeSafe',
      answers: { [questionId]: { type: 'noul', noul } },
      usage: { input_tokens: 10, output_tokens: 2, cost: 0.00002 },
    })
  }) as typeof fetch
}

function clientWith(options: SmokeFetchOptions) {
  return createJevClient({
    apiKey: 'test-key',
    fetchImpl: smokeFetch(options),
    cache: false,
  })
}

describe('Jev smoke suite (gate G4)', () => {
  it('passes for valid pinned-model distributions on all three questions', async () => {
    const report = await runJevSmokeSuite(clientWith({}))

    expect(report.passed).toBe(true)
    expect(report.failures).toEqual([])
    expect(report.observations.map((observation) => observation.role)).toEqual([
      'english',
      'french',
      'unsettled',
    ])
    expect(report.observations.map((observation) => observation.caseId)).toEqual([
      SMOKE_EN_QUESTION_ID,
      SMOKE_FR_QUESTION_ID,
      SMOKE_UNSETTLED_QUESTION_ID,
    ])

    for (const observation of report.observations) {
      expect(observation.ok).toBe(true)
      expect(observation.servedModel).toBe('typesafe/jev-1.14-20261014')
      expect(observation.distribution?.kind).toBe('noul')
      expect(observation.errorCode).toBeNull()
    }

    expect(report.totalCostUsd).toBeCloseTo(0.00006, 10)
    expect(() => assertJevSmokeSuite(report)).not.toThrow()
  })

  it.each([0, 1])('fails when the unsettled answer is forced to a side (noul=%s)', async (noul) => {
    const report = await runJevSmokeSuite(
      clientWith({ probabilities: { [SMOKE_UNSETTLED_QUESTION_ID]: noul } }),
    )

    expect(report.passed).toBe(false)
    expect(report.failures.join('\n')).toMatch(/unsettled .*forced to a side/)
    expect(() => assertJevSmokeSuite(report)).toThrow(/failed/)
  })

  it.each([
    ['english', SMOKE_EN_QUESTION_ID],
    ['french', SMOKE_FR_QUESTION_ID],
  ] as const)('fails when the %s question fails', async (role, questionId) => {
    const report = await runJevSmokeSuite(clientWith({ failQuestionId: questionId }))

    expect(report.passed).toBe(false)
    expect(report.failures.join('\n')).toMatch(new RegExp(`${role} .*jev_unavailable`))

    const observation = report.observations.find((item) => item.role === role)
    expect(observation?.ok).toBe(false)
    expect(observation?.errorCode).toBe('jev_unavailable')
  })

  it('fails when the API serves another model', async () => {
    const report = await runJevSmokeSuite(clientWith({ model: 'typesafe/jev-1.13-20260917' }))

    expect(report.passed).toBe(false)
    expect(report.observations.every((observation) => !observation.ok)).toBe(true)
    expect(report.failures.join('\n')).toMatch(/pinned/)
  })

  it('does not crash when the judge itself throws', async () => {
    const report = await runJevSmokeSuite({
      judge: async () => {
        throw new Error('boom')
      },
    })

    expect(report.passed).toBe(false)
    expect(report.failures).toHaveLength(3)
    expect(report.failures.join('\n')).toMatch(/judge threw: boom/)
    expect(report.observations.every((observation) => observation.errorCode === 'jev_threw')).toBe(
      true,
    )
  })
})

describe('JEV_MODEL pin', () => {
  it('is the committed pin', () => {
    expect(JEV_MODEL).toBe('typesafe/jev-1.14')
  })
})
