import { describe, expect, it } from 'vitest'
import { createJevClient } from './client.js'
import { JEV_MODEL, JEV_SMOKE_SUITE_ID } from './constants.js'
import { JevUnavailableError } from './errors.js'
import {
  SMOKE_EN_QUESTION_ID,
  SMOKE_FR_QUESTION_ID,
  SMOKE_UNSETTLED_QUESTION_ID,
} from './questions.js'
import {
  JEV_SMOKE_CASES,
  assertJevSmokeSuite,
  runJevSmokeSuite,
  type JevSmokeReport,
} from './smoke-suite.js'
import type {
  JevDistribution,
  JevGrader,
  JevJudgment,
  JevJudgmentFailure,
  JevJudgmentSuccess,
  JevResult,
  JevUsage,
} from './types.js'

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
    expect(
      report.observations.find((observation) => observation.caseId === SMOKE_UNSETTLED_QUESTION_ID)
        ?.ok,
    ).toBe(false)
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
      grade: async () => {
        throw new Error('boom')
      },
    })

    expect(report.passed).toBe(false)
    expect(report.failures).toHaveLength(3)
    expect(report.failures.join('\n')).toMatch(/grader threw: boom/)
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

interface SuccessOptions {
  readonly distribution?: JevDistribution
  readonly servedModel?: string
  readonly usage?: JevUsage
  readonly cacheHit?: boolean
}

function smokeSuccess(judgment: JevJudgment, options: SuccessOptions = {}): JevJudgmentSuccess {
  return {
    ok: true,
    questionId: judgment.metadata.id,
    request: {
      model: JEV_MODEL,
      state: judgment.state,
      questions: { [judgment.metadata.id]: judgment.question },
    },
    response: { model: JEV_MODEL, answers: {}, usage: { input_tokens: 1, output_tokens: 1 } },
    raw: {},
    distribution: options.distribution ?? {
      kind: 'noul',
      probabilityYes: 0.5,
      probabilityNo: 0.5,
    },
    usage: options.usage ?? { input_tokens: 1, output_tokens: 1 },
    servedModel: options.servedModel ?? JEV_MODEL,
    cache: { key: null, hit: options.cacheHit ?? false, stored: false },
  }
}

function smokeFailure(
  judgment: JevJudgment,
  options: { readonly message: string; readonly cacheHit?: boolean },
): JevJudgmentFailure {
  return {
    ok: false,
    questionId: judgment.metadata.id,
    error: new JevUnavailableError(options.message, { reason: 'http', status: 500 }),
    cache: { key: null, hit: options.cacheHit ?? false, stored: false },
  }
}

function graderFrom(build: (judgment: JevJudgment, index: number) => JevResult): JevGrader {
  let index = 0
  return {
    grade: async (judgment) => build(judgment, index++),
  }
}

describe('Jev smoke suite report shape', () => {
  it('runs the three cases in order and stamps the suite id and the pin', async () => {
    const seen: JevJudgment[] = []
    const report = await runJevSmokeSuite(
      graderFrom((judgment) => {
        seen.push(judgment)
        return smokeSuccess(judgment)
      }),
    )

    expect(report.suiteId).toBe(JEV_SMOKE_SUITE_ID)
    expect(report.pinnedModel).toBe(JEV_MODEL)
    expect(report.passed).toBe(true)
    expect(report.failures).toStrictEqual([])
    expect(
      report.observations.map(({ caseId, role, lang }) => ({ caseId, role, lang })),
    ).toStrictEqual([
      { caseId: SMOKE_EN_QUESTION_ID, role: 'english', lang: 'en' },
      { caseId: SMOKE_FR_QUESTION_ID, role: 'french', lang: 'fr' },
      { caseId: SMOKE_UNSETTLED_QUESTION_ID, role: 'unsettled', lang: 'en' },
    ])
    expect(seen.map((judgment) => judgment.metadata.id)).toStrictEqual([
      SMOKE_EN_QUESTION_ID,
      SMOKE_FR_QUESTION_ID,
      SMOKE_UNSETTLED_QUESTION_ID,
    ])
    for (const smoke of JEV_SMOKE_CASES) {
      expect(smoke.id).toBe(smoke.judgment.metadata.id)
      expect(smoke.lang).toBe(smoke.judgment.metadata.lang)
    }
  })

  it('accepts settled boolean answers at either extreme', async () => {
    const report = await runJevSmokeSuite(
      graderFrom((judgment) => {
        if (judgment.metadata.id === SMOKE_EN_QUESTION_ID) {
          return smokeSuccess(judgment, {
            distribution: { kind: 'noul', probabilityYes: 1, probabilityNo: 0 },
          })
        }
        if (judgment.metadata.id === SMOKE_FR_QUESTION_ID) {
          return smokeSuccess(judgment, {
            distribution: { kind: 'noul', probabilityYes: 0, probabilityNo: 1 },
          })
        }
        return smokeSuccess(judgment)
      }),
    )

    expect(report.failures).toStrictEqual([])
    expect(report.passed).toBe(true)
  })

  it('sums only the costs the API reports and records each case cost', async () => {
    const report = await runJevSmokeSuite(
      graderFrom((judgment, index) =>
        smokeSuccess(judgment, {
          usage:
            index === 0
              ? { input_tokens: 1, output_tokens: 1, cost: 0.25 }
              : { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    )

    expect(report.passed).toBe(true)
    expect(report.totalCostUsd).toBe(0.25)
    expect(report.observations.map((observation) => observation.costUsd)).toStrictEqual([
      0.25, 0, 0,
    ])
  })

  it('reports a failure result with its code, message and cache hit', async () => {
    const report = await runJevSmokeSuite(
      graderFrom((judgment) =>
        judgment.metadata.id === SMOKE_FR_QUESTION_ID
          ? smokeFailure(judgment, { message: 'provider down', cacheHit: true })
          : smokeSuccess(judgment),
      ),
    )

    expect(report.passed).toBe(false)
    expect(report.failures).toStrictEqual([
      `french (${SMOKE_FR_QUESTION_ID}): jev_unavailable: provider down`,
    ])
    expect(report.observations[1]).toStrictEqual({
      caseId: SMOKE_FR_QUESTION_ID,
      role: 'french',
      lang: 'fr',
      ok: false,
      servedModel: null,
      distribution: null,
      errorCode: 'jev_unavailable',
      errorMessage: 'provider down',
      cacheHit: true,
      costUsd: 0,
    })
    expect(report.totalCostUsd).toBe(0)
  })

  it('keeps a non-Error throw as its message', async () => {
    const report = await runJevSmokeSuite({
      grade: async () => {
        throw 'provider exploded'
      },
    })

    expect(report.failures).toStrictEqual([
      `english (${SMOKE_EN_QUESTION_ID}): grader threw: provider exploded`,
      `french (${SMOKE_FR_QUESTION_ID}): grader threw: provider exploded`,
      `unsettled (${SMOKE_UNSETTLED_QUESTION_ID}): grader threw: provider exploded`,
    ])
  })

  it('records a throw observation with no served model, distribution or cache hit', async () => {
    const report = await runJevSmokeSuite({
      grade: async () => {
        throw new Error('boom')
      },
    })

    expect(report.observations[0]).toStrictEqual({
      caseId: SMOKE_EN_QUESTION_ID,
      role: 'english',
      lang: 'en',
      ok: false,
      servedModel: null,
      distribution: null,
      errorCode: 'jev_threw',
      errorMessage: 'boom',
      cacheHit: false,
      costUsd: 0,
    })
  })

  it('names the served and pinned models exactly when the pin is wrong', async () => {
    const servedModel = 'typesafe/jev-1.13-20260917'
    const report = await runJevSmokeSuite(
      graderFrom((judgment) => smokeSuccess(judgment, { servedModel })),
    )

    expect(report.failures).toStrictEqual([
      `english (${SMOKE_EN_QUESTION_ID}): served model ${JSON.stringify(servedModel)} is not pinned to ${JEV_MODEL}`,
      `french (${SMOKE_FR_QUESTION_ID}): served model ${JSON.stringify(servedModel)} is not pinned to ${JEV_MODEL}`,
      `unsettled (${SMOKE_UNSETTLED_QUESTION_ID}): served model ${JSON.stringify(servedModel)} is not pinned to ${JEV_MODEL}`,
    ])
  })
})

describe('Jev smoke suite distribution checks', () => {
  it('reports a choice distribution for a noul question', async () => {
    const report = await runJevSmokeSuite(
      graderFrom((judgment) =>
        judgment.metadata.id === SMOKE_EN_QUESTION_ID
          ? smokeSuccess(judgment, {
              distribution: {
                kind: 'choice',
                choice: 'peer',
                probabilities: { peer: 0.5, manager: 0.5 },
              },
            })
          : smokeSuccess(judgment),
      ),
    )

    expect(report.failures).toStrictEqual([
      `english (${SMOKE_EN_QUESTION_ID}): choice distribution does not match noul question`,
    ])
  })

  it('reports a score distribution for a noul question', async () => {
    const report = await runJevSmokeSuite(
      graderFrom((judgment) =>
        judgment.metadata.id === SMOKE_FR_QUESTION_ID
          ? smokeSuccess(judgment, {
              distribution: {
                kind: 'score',
                score: 1,
                probabilities: { '0': 0.4, '1': 0.6 },
              },
            })
          : smokeSuccess(judgment),
      ),
    )

    expect(report.failures).toStrictEqual([
      `french (${SMOKE_FR_QUESTION_ID}): score distribution does not match noul question`,
    ])
  })

  it('reports an empty distribution', async () => {
    const report = await runJevSmokeSuite(
      graderFrom((judgment) =>
        judgment.metadata.id === SMOKE_EN_QUESTION_ID
          ? smokeSuccess(judgment, {
              distribution: { kind: 'choice', choice: 'peer', probabilities: {} },
            })
          : smokeSuccess(judgment),
      ),
    )

    expect(report.failures).toStrictEqual([
      `english (${SMOKE_EN_QUESTION_ID}): choice distribution does not match noul question`,
      `english (${SMOKE_EN_QUESTION_ID}): distribution is empty`,
    ])
  })

  it('reports each out-of-range probability with its label and value', async () => {
    const report = await runJevSmokeSuite(
      graderFrom((judgment) =>
        judgment.metadata.id === SMOKE_EN_QUESTION_ID
          ? smokeSuccess(judgment, {
              distribution: { kind: 'noul', probabilityYes: 2, probabilityNo: -1 },
            })
          : smokeSuccess(judgment),
      ),
    )

    expect(report.failures).toStrictEqual([
      `english (${SMOKE_EN_QUESTION_ID}): invalid probability yes=2`,
      `english (${SMOKE_EN_QUESTION_ID}): invalid probability no=-1`,
    ])
  })

  it.each([
    [Number.POSITIVE_INFINITY, 'yes=Infinity'],
    [Number.NaN, 'yes=NaN'],
  ])('rejects the non-finite probability %s', async (yes, rendered) => {
    const report = await runJevSmokeSuite(
      graderFrom((judgment) =>
        judgment.metadata.id === SMOKE_EN_QUESTION_ID
          ? smokeSuccess(judgment, {
              distribution: { kind: 'noul', probabilityYes: yes, probabilityNo: 0.5 },
            })
          : smokeSuccess(judgment),
      ),
    )

    expect(report.failures).toStrictEqual([
      `english (${SMOKE_EN_QUESTION_ID}): invalid probability ${rendered}`,
    ])
    expect(report.observations[0]?.ok).toBe(false)
  })

  it('reports an unsettled case that is not a noul distribution', async () => {
    const report = await runJevSmokeSuite(
      graderFrom((judgment) =>
        judgment.metadata.id === SMOKE_UNSETTLED_QUESTION_ID
          ? smokeSuccess(judgment, {
              distribution: {
                kind: 'choice',
                choice: 'ship',
                probabilities: { ship: 0.5, wait: 0.5 },
              },
            })
          : smokeSuccess(judgment),
      ),
    )

    expect(report.failures).toStrictEqual([
      `unsettled (${SMOKE_UNSETTLED_QUESTION_ID}): choice distribution does not match noul question`,
      `unsettled (${SMOKE_UNSETTLED_QUESTION_ID}): unsettled case must return a two-sided noul distribution`,
    ])
  })

  it.each([
    [0, ['yes=0', 'no=1']],
    [1, ['yes=1', 'no=0']],
  ])('names both forced sides exactly when the unsettled noul is %s', async (noul, sides) => {
    const report = await runJevSmokeSuite(
      graderFrom((judgment) =>
        judgment.metadata.id === SMOKE_UNSETTLED_QUESTION_ID
          ? smokeSuccess(judgment, {
              distribution: {
                kind: 'noul',
                probabilityYes: noul,
                probabilityNo: 1 - noul,
              },
            })
          : smokeSuccess(judgment),
      ),
    )

    expect(report.failures).toStrictEqual(
      sides.map(
        (side) =>
          `unsettled (${SMOKE_UNSETTLED_QUESTION_ID}): unsettled case forced to a side (${side})`,
      ),
    )
  })

  it('fails loudly on a distribution kind the reducer cannot handle', async () => {
    const bogus = { kind: 'bogus' } as unknown as JevDistribution

    await expect(
      runJevSmokeSuite(graderFrom((judgment) => smokeSuccess(judgment, { distribution: bogus }))),
    ).rejects.toThrow('Unhandled Jev distribution: {"kind":"bogus"}')
  })
})

describe('assertJevSmokeSuite', () => {
  it('throws the suite id and every failure when the gate fails', () => {
    const report: JevSmokeReport = {
      suiteId: JEV_SMOKE_SUITE_ID,
      pinnedModel: JEV_MODEL,
      passed: false,
      failures: ['english: jev_unavailable: provider down', 'french: served model is not pinned'],
      observations: [],
      totalCostUsd: 0,
    }

    expect(() => assertJevSmokeSuite(report)).toThrow(
      `Jev smoke suite ${JEV_SMOKE_SUITE_ID} failed:\n- english: jev_unavailable: provider down\n- french: served model is not pinned`,
    )
  })

  it('returns quietly when the gate passed', () => {
    const report: JevSmokeReport = {
      suiteId: JEV_SMOKE_SUITE_ID,
      pinnedModel: JEV_MODEL,
      passed: true,
      failures: [],
      observations: [],
      totalCostUsd: 0,
    }

    expect(() => assertJevSmokeSuite(report)).not.toThrow()
  })
})
