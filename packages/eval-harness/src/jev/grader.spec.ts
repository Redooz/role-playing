import { describe, expect, it } from 'vitest'
import { TRANSCRIPT_SCHEMA_VERSION, expectedContentClass } from '@rp/session-core'
import type { SessionEventName, TranscriptRecord } from '@rp/session-core'
import {
  createJevAxisGrader,
  M2_AXES,
  M2_JEV_GRADER_ID,
  M2_JEV_RUBRIC_VERSION,
  M2_JEV_THRESHOLD,
} from './grader.js'
import { JEV_GRADER_VERSION, JEV_MODEL, NO_EXTRACTION_VERSION } from './constants.js'
import type {
  JevDistribution,
  JevGrader,
  JevJudgment,
  JevResult,
  JevJudgmentSuccess,
} from './types.js'
import type { TrialRecord } from '../runner/grader.js'
import type { TrialSpeechMetrics } from '../runner/speech.js'
import type { TaskEntry } from '../tasks/schema.js'

function task(locale: string | undefined): TaskEntry {
  return {
    id: locale === undefined ? 'en-session-001' : `${locale}-session-001`,
    lang: locale?.startsWith('fr') === true ? 'fr' : 'en',
    ...(locale === undefined ? {} : { locale }),
    mode: 'session',
    domain: 'workplace',
    scenarioType: 'request-deadline-extension',
    cefrBand: 'B1',
    speakerId: 'speaker-001',
    split: 'calibration',
    provenance: { source: 'synthetic' },
    consentScope: 'synthetic-no-consent-required',
    annotationVersions: { rubric: 'v2' },
    content: { turns: [] },
    session: {
      personaId: 'manager',
      personaVersion: '1.0.0',
      scenarioId: 'request-deadline-extension',
      scenarioVersion: '1.0.0',
      scriptedUserTurns: ['Could I have two more days?'],
    },
  } as TaskEntry
}

function records(): TranscriptRecord[] {
  const events = [
    { kind: 'user.utterance.committed' as const, payload: { text: 'Could I have two more days?' } },
    {
      kind: 'persona.response.committed' as const,
      payload: { text: 'How much time, and what is still missing?' },
    },
  ]
  return events.map((event, seq) => ({
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    runId: 'run-1',
    seq,
    tSim: 0,
    tWall: 0,
    kind: event.kind,
    payload: event.payload,
    contentClass: expectedContentClass(event.kind),
  }))
}

function trial(locale: string | undefined): TrialRecord {
  return {
    round: 0,
    taskId: 'task',
    lang: locale?.startsWith('fr') === true ? 'fr' : 'en',
    ok: true,
    records: records(),
    violations: [],
    schemaValid: true,
    sequenceValid: true,
    contentClassValid: true,
    providerOutage: false,
    task: task(locale),
  }
}

function fakeJev(probability = 0.82): JevGrader & { calls: JevJudgment[] } {
  const calls: JevJudgment[] = []
  return {
    calls,
    async grade(judgment): Promise<JevResult> {
      calls.push(judgment)
      return {
        ok: true,
        questionId: judgment.metadata.id,
        request: {
          model: 'typesafe/jev-1.14',
          state: judgment.state,
          questions: { [judgment.metadata.id]: judgment.question },
        },
        response: {
          model: 'typesafe/jev-1.14-20261014',
          answers: { [judgment.metadata.id]: { type: 'noul', noul: probability } },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        raw: {},
        distribution: { kind: 'noul', probabilityYes: probability, probabilityNo: 1 - probability },
        usage: { input_tokens: 1, output_tokens: 1 },
        servedModel: 'typesafe/jev-1.14-20261014',
        cache: { key: 'k', hit: false, stored: true },
      }
    },
  }
}

const CONTEXT = (candidate: TrialRecord) => ({
  manifest: {} as never,
  trials: [candidate],
})

describe('Jev axis grader', () => {
  it('asks one atomic question per axis and stores raw probabilities', async () => {
    const jev = fakeJev(0.82)
    const grader = createJevAxisGrader({ client: jev })
    const candidate = trial(undefined)

    const metrics = await grader.score(CONTEXT(candidate))
    const details = await grader.details?.(CONTEXT(candidate))

    expect(jev.calls).toHaveLength(M2_AXES.length - 1)
    expect(Object.keys(metrics).sort()).toEqual(
      [
        ...M2_AXES.filter((axis) => axis !== 'locale.fit'),
        'response.emoji_count',
        'response.markdown_count',
        'response.plain_text_rate',
        'run.failure_rate',
      ].sort(),
    )
    expect(metrics['persona.consistency']).toBeCloseTo(0.82)
    expect(details).toHaveLength(M2_AXES.length - 1)
    expect(details?.every((detail) => detail.probability === 0.82)).toBe(true)
    expect(details?.[0]?.threshold).toBe(0.75)
    expect(details?.[0]?.servedModel).toBe('typesafe/jev-1.14-20261014')
  })

  it('adds the locale-fit axis for a locale variant and stamps the locale', async () => {
    const jev = fakeJev()
    const grader = createJevAxisGrader({ client: jev })
    const candidate = trial('en-GB')

    const metrics = await grader.score(CONTEXT(candidate))
    const details = await grader.details?.(CONTEXT(candidate))

    expect(Object.keys(metrics).sort()).toEqual(
      [
        ...M2_AXES,
        'response.emoji_count',
        'response.markdown_count',
        'response.plain_text_rate',
        'run.failure_rate',
      ].sort(),
    )
    expect(details?.[0]?.locale).toBe('en-GB')
    expect(jev.calls.every((call) => call.metadata.locale === 'en-GB')).toBe(true)
  })

  it('declares the rubric it can ask', () => {
    const grader = createJevAxisGrader({ client: fakeJev() })
    expect(grader.rubricVersion).toBe(M2_JEV_RUBRIC_VERSION)
  })

  it('writes French questions for a French trial', async () => {
    const jev = fakeJev()
    const grader = createJevAxisGrader({ client: jev })
    await grader.score(CONTEXT(trial('fr-CA')))
    expect(jev.calls.every((call) => call.metadata.lang === 'fr')).toBe(true)
    expect(jev.calls[0]?.question.instructions).toMatch(/rôle professionnel/)
    expect(jev.calls.every((call) => call.metadata.rubricVersion === M2_JEV_RUBRIC_VERSION)).toBe(
      true,
    )
    expect(
      jev.calls.some((call) => /accents et traits d’union/u.test(call.question.instructions)),
    ).toBe(true)
    expect(jev.calls.some((call) => /« tu » ou « vous »/u.test(call.question.instructions))).toBe(
      true,
    )
  })

  it('fails the run when Jev returns an error instead of turning it into a no', async () => {
    const failing: JevGrader = {
      async grade(judgment) {
        return {
          ok: false,
          questionId: judgment.metadata.id,
          error: { name: 'JevUnavailableError', message: 'network down' } as never,
          cache: { key: null, hit: false, stored: false },
        }
      },
    }
    const grader = createJevAxisGrader({ client: failing })
    await expect(grader.score(CONTEXT(trial(undefined)))).rejects.toThrow(/not a "no"/)
  })
})

/* ------------------------------------------------------------------------- */
/* Extended contract coverage                                                */
/* ------------------------------------------------------------------------- */

const SERVED_MODEL = 'typesafe/jev-1.14-20261014'

function recordAt(seq: number, kind: SessionEventName, payload: unknown): TranscriptRecord {
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    runId: 'run-1',
    seq,
    tSim: 0,
    tWall: 0,
    kind,
    payload,
    contentClass: expectedContentClass(kind),
  }
}

function successResult(judgment: JevJudgment, probability: number): JevJudgmentSuccess {
  return {
    ok: true,
    questionId: judgment.metadata.id,
    request: {
      model: JEV_MODEL,
      state: judgment.state,
      questions: { [judgment.metadata.id]: judgment.question },
    },
    response: {
      model: SERVED_MODEL,
      answers: { [judgment.metadata.id]: { type: 'noul', noul: probability } },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    raw: {},
    distribution: { kind: 'noul', probabilityYes: probability, probabilityNo: 1 - probability },
    usage: { input_tokens: 1, output_tokens: 1 },
    servedModel: SERVED_MODEL,
    cache: { key: 'k', hit: false, stored: true },
  }
}

function failureResult(judgment: JevJudgment, message: string): JevResult {
  return {
    ok: false,
    questionId: judgment.metadata.id,
    error: { name: 'JevUnavailableError', message } as never,
    cache: { key: null, hit: false, stored: false },
  }
}

function stubJev(respond: (judgment: JevJudgment) => JevResult): JevGrader & {
  calls: JevJudgment[]
} {
  const calls: JevJudgment[] = []
  return {
    calls,
    async grade(judgment): Promise<JevResult> {
      calls.push(judgment)
      return respond(judgment)
    },
  }
}

function contextOf(...trials: TrialRecord[]) {
  return { manifest: {} as never, trials }
}

function variant(locale: string | undefined, overrides: Partial<TrialRecord>): TrialRecord {
  return { ...trial(locale), ...overrides }
}

function sessionBlock(entry: TaskEntry): NonNullable<TaskEntry['session']> {
  return entry.session as NonNullable<TaskEntry['session']>
}

function speechMetrics(
  plainTextRate: number,
  emojiCount = 0,
  markdownCount = 0,
): TrialSpeechMetrics {
  return { plainTextRate, emojiCount, markdownCount, emptyResponses: 0 }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected the grader to reject')
    },
    (error: unknown) => error as Error,
  )
}

const BASE_QUESTION_OBJECTS = [
  {
    type: 'noul',
    instructions: 'Do all persona replies stay in the same professional role and voice?',
    criteria: {
      true: 'Every reply is consistent with one role, tone and set of boundaries.',
      false: 'A reply breaks role, changes voice, or behaves like a generic assistant.',
    },
  },
  {
    type: 'noul',
    instructions:
      'Are the persona replies written in correct English with appropriate grammar and vocabulary?',
    criteria: {
      true: 'The replies are fluent English with no distracting grammar or vocabulary error.',
      false: 'The replies contain a serious grammar, vocabulary or language error.',
    },
  },
  {
    type: 'noul',
    instructions:
      'Is the register appropriate for the workplace relationship described in the scenario?',
    criteria: {
      true: 'The replies match the expected formality and diplomacy for this relationship.',
      false: 'The replies are too casual, too formal, or impolite for this relationship.',
    },
  },
  {
    type: 'noul',
    instructions: 'Are the persona replies clear and concise rather than rambling?',
    criteria: {
      true: 'The replies are understandable and reasonably concise.',
      false: 'The replies are confusing, repetitive or long-winded.',
    },
  },
  {
    type: 'noul',
    instructions: 'Do the persona replies help the learner complete the scenario objective?',
    criteria: {
      true: 'The replies create a realistic opening and respond to the learner in a way that lets the objective be met.',
      false:
        'The replies block the objective, ignore the learner, or invent facts that make it impossible.',
    },
  },
] as const

const LOCALE_QUESTION_OBJECT = {
  type: 'noul',
  instructions:
    'Do the persona replies use the spelling, vocabulary and workplace norms of the stated locale?',
  criteria: {
    true: 'The replies consistently match the stated locale rather than a different regional variant.',
    false: 'The replies use another locale’s spelling, vocabulary or workplace norms.',
  },
} as const

describe('Jev axis grader: identity and details cache', () => {
  it('publishes the pinned grader identity', () => {
    const grader = createJevAxisGrader({ client: fakeJev() })
    expect(grader.id).toBe('jev')
    expect(M2_JEV_GRADER_ID).toBe('jev')
    expect(grader.kind).toBe('system-one-model')
    expect(grader.version).toBe(JEV_MODEL)
    expect(grader.model).toBe(JEV_MODEL)
    expect(grader.rubricVersion).toBe(M2_JEV_RUBRIC_VERSION)
  })

  it('returns no detail rows before the first score call', async () => {
    const grader = createJevAxisGrader({ client: fakeJev() })
    expect(await grader.details?.(CONTEXT(trial(undefined)))).toStrictEqual([])
  })

  it('returns the last score rows and replaces them on a second score', async () => {
    const grader = createJevAxisGrader({ client: fakeJev(0.875) })
    await grader.score(CONTEXT(variant(undefined, { round: 3 })))
    const first = await grader.details?.(CONTEXT(variant(undefined, { round: 3 })))

    expect(first).toHaveLength(5)
    expect(first?.every((detail) => detail.trialId === '3:en:en-session-001')).toBe(true)

    await grader.score(CONTEXT(variant(undefined, { round: 4 })))
    const second = await grader.details?.(CONTEXT(variant(undefined, { round: 3 })))

    expect(second).toHaveLength(5)
    expect(second?.every((detail) => detail.trialId === '4:en:en-session-001')).toBe(true)
  })
})

describe('Jev axis grader: base-language axis contract', () => {
  it('stamps every base-axis judgment with the pinned metadata', async () => {
    const jev = fakeJev(0.875)
    const grader = createJevAxisGrader({ client: jev })
    await grader.score(CONTEXT(trial(undefined)))

    expect(jev.calls.map((call) => call.metadata)).toStrictEqual([
      {
        id: 'm2-0:en:en-session-001-persona.consistency',
        lang: 'en',
        locale: 'en',
        rubricVersion: M2_JEV_RUBRIC_VERSION,
        graderVersion: JEV_GRADER_VERSION,
        extractionVersion: NO_EXTRACTION_VERSION,
      },
      {
        id: 'm2-0:en:en-session-001-language.quality',
        lang: 'en',
        locale: 'en',
        rubricVersion: M2_JEV_RUBRIC_VERSION,
        graderVersion: JEV_GRADER_VERSION,
        extractionVersion: NO_EXTRACTION_VERSION,
      },
      {
        id: 'm2-0:en:en-session-001-register.fit',
        lang: 'en',
        locale: 'en',
        rubricVersion: M2_JEV_RUBRIC_VERSION,
        graderVersion: JEV_GRADER_VERSION,
        extractionVersion: NO_EXTRACTION_VERSION,
      },
      {
        id: 'm2-0:en:en-session-001-response.clarity',
        lang: 'en',
        locale: 'en',
        rubricVersion: M2_JEV_RUBRIC_VERSION,
        graderVersion: JEV_GRADER_VERSION,
        extractionVersion: NO_EXTRACTION_VERSION,
      },
      {
        id: 'm2-0:en:en-session-001-objective.completion',
        lang: 'en',
        locale: 'en',
        rubricVersion: M2_JEV_RUBRIC_VERSION,
        graderVersion: JEV_GRADER_VERSION,
        extractionVersion: NO_EXTRACTION_VERSION,
      },
    ])
  })

  it('asks one exact English yes/no question per base axis', async () => {
    const jev = fakeJev(0.875)
    const grader = createJevAxisGrader({ client: jev })
    await grader.score(CONTEXT(trial(undefined)))

    expect(jev.calls.map((call) => call.question)).toStrictEqual(BASE_QUESTION_OBJECTS)
  })

  it('returns one exact detail row per base axis and no locale.fit row', async () => {
    const jev = fakeJev(0.875)
    const grader = createJevAxisGrader({ client: jev })
    const metrics = await grader.score(CONTEXT(trial(undefined)))
    const details = await grader.details?.(CONTEXT(trial(undefined)))

    expect(details).toHaveLength(5)
    expect(details).toStrictEqual([
      {
        trialId: '0:en:en-session-001',
        axis: 'persona.consistency',
        metric: 'persona.consistency',
        question: BASE_QUESTION_OBJECTS[0].instructions,
        probability: 0.875,
        threshold: M2_JEV_THRESHOLD,
        distribution: { yes: 0.875, no: 0.125 },
        locale: 'en',
        servedModel: SERVED_MODEL,
        cacheHit: false,
      },
      {
        trialId: '0:en:en-session-001',
        axis: 'language.quality',
        metric: 'language.quality',
        question: BASE_QUESTION_OBJECTS[1].instructions,
        probability: 0.875,
        threshold: M2_JEV_THRESHOLD,
        distribution: { yes: 0.875, no: 0.125 },
        locale: 'en',
        servedModel: SERVED_MODEL,
        cacheHit: false,
      },
      {
        trialId: '0:en:en-session-001',
        axis: 'register.fit',
        metric: 'register.fit',
        question: BASE_QUESTION_OBJECTS[2].instructions,
        probability: 0.875,
        threshold: M2_JEV_THRESHOLD,
        distribution: { yes: 0.875, no: 0.125 },
        locale: 'en',
        servedModel: SERVED_MODEL,
        cacheHit: false,
      },
      {
        trialId: '0:en:en-session-001',
        axis: 'response.clarity',
        metric: 'response.clarity',
        question: BASE_QUESTION_OBJECTS[3].instructions,
        probability: 0.875,
        threshold: M2_JEV_THRESHOLD,
        distribution: { yes: 0.875, no: 0.125 },
        locale: 'en',
        servedModel: SERVED_MODEL,
        cacheHit: false,
      },
      {
        trialId: '0:en:en-session-001',
        axis: 'objective.completion',
        metric: 'objective.completion',
        question: BASE_QUESTION_OBJECTS[4].instructions,
        probability: 0.875,
        threshold: M2_JEV_THRESHOLD,
        distribution: { yes: 0.875, no: 0.125 },
        locale: 'en',
        servedModel: SERVED_MODEL,
        cacheHit: false,
      },
    ])

    expect(metrics).toStrictEqual({
      'persona.consistency': 0.875,
      'language.quality': 0.875,
      'register.fit': 0.875,
      'response.clarity': 0.875,
      'objective.completion': 0.875,
      'response.plain_text_rate': 0,
      'response.emoji_count': 0,
      'response.markdown_count': 0,
      'run.failure_rate': 0,
    })
  })
})

describe('Jev axis grader: locale variants', () => {
  it('adds the exact locale.fit axis for a locale variant', async () => {
    const jev = fakeJev(0.875)
    const grader = createJevAxisGrader({ client: jev })
    const metrics = await grader.score(CONTEXT(trial('en-GB')))
    const details = await grader.details?.(CONTEXT(trial('en-GB')))

    expect(jev.calls).toHaveLength(M2_AXES.length)
    expect(jev.calls.map((call) => call.question)).toStrictEqual([
      ...BASE_QUESTION_OBJECTS,
      LOCALE_QUESTION_OBJECT,
    ])
    expect(jev.calls.every((call) => call.metadata.locale === 'en-GB')).toBe(true)
    expect(details).toHaveLength(6)
    expect(details?.[5]).toStrictEqual({
      trialId: '0:en:en-GB-session-001',
      axis: 'locale.fit',
      metric: 'locale.fit',
      question: LOCALE_QUESTION_OBJECT.instructions,
      probability: 0.875,
      threshold: M2_JEV_THRESHOLD,
      distribution: { yes: 0.875, no: 0.125 },
      locale: 'en-GB',
      servedModel: SERVED_MODEL,
      cacheHit: false,
    })
    expect(metrics).toStrictEqual({
      'persona.consistency': 0.875,
      'language.quality': 0.875,
      'register.fit': 0.875,
      'response.clarity': 0.875,
      'objective.completion': 0.875,
      'locale.fit': 0.875,
      'response.plain_text_rate': 0,
      'response.emoji_count': 0,
      'response.markdown_count': 0,
      'run.failure_rate': 0,
    })
  })

  it('canonicalises the task locale before it enters the question and the row', async () => {
    const jev = fakeJev(0.875)
    const grader = createJevAxisGrader({ client: jev })
    const canonicalised = variant(undefined, {
      task: { ...task(undefined), locale: 'EN-gb' },
    })

    const details = await grader
      .score(CONTEXT(canonicalised))
      .then(() => grader.details?.(CONTEXT(canonicalised)))

    expect(jev.calls.every((call) => call.metadata.locale === 'en-GB')).toBe(true)
    expect(details?.[0]?.locale).toBe('en-GB')
    expect(jev.calls[0]?.state).toMatchObject({ locale: 'en-GB' })
    expect(details).toHaveLength(6)
  })

  it('writes the exact French register question and criteria', async () => {
    const jev = fakeJev(0.875)
    const grader = createJevAxisGrader({ client: jev })
    await grader.score(CONTEXT(trial('fr-CA')))

    expect(jev.calls.map((call) => call.metadata.lang)).toStrictEqual([
      'fr',
      'fr',
      'fr',
      'fr',
      'fr',
      'fr',
    ])
    expect(jev.calls[2]?.question).toStrictEqual({
      type: 'noul',
      instructions:
        'Le registre est-il adapté à la relation professionnelle décrite dans le scénario, y compris l’emploi cohérent de « tu » ou « vous » avec l’apprenant ?',
      criteria: {
        true: 'Les réponses correspondent au niveau de formalité et de diplomatie attendu et gardent un choix cohérent entre « tu » et « vous ».',
        false:
          'Les réponses sont trop familières, trop formelles ou impolies, ou alternent entre « tu » et « vous » de façon incohérente pour cette relation.',
      },
    })
  })
})

describe('Jev axis grader: per-axis averages', () => {
  it('averages a two-trial fractional mean per axis', async () => {
    const jev = stubJev((judgment) =>
      successResult(judgment, judgment.metadata.id.startsWith('m2-0:') ? 0.5 : 0.75),
    )
    const grader = createJevAxisGrader({ client: jev })
    const metrics = await grader.score(
      contextOf(variant(undefined, { round: 0 }), variant(undefined, { round: 1 })),
    )
    const details = await grader.details?.(contextOf())

    expect(metrics['persona.consistency']).toBe(0.625)
    expect(metrics['language.quality']).toBe(0.625)
    expect(metrics['register.fit']).toBe(0.625)
    expect(metrics['response.clarity']).toBe(0.625)
    expect(metrics['objective.completion']).toBe(0.625)
    expect(details).toHaveLength(10)
    expect(details?.map((detail) => detail.trialId)).toStrictEqual([
      '0:en:en-session-001',
      '0:en:en-session-001',
      '0:en:en-session-001',
      '0:en:en-session-001',
      '0:en:en-session-001',
      '1:en:en-session-001',
      '1:en:en-session-001',
      '1:en:en-session-001',
      '1:en:en-session-001',
      '1:en:en-session-001',
    ])
  })

  it('averages a three-trial mean per axis', async () => {
    const probabilities = [0.25, 0.5, 0.75]
    const jev = stubJev((judgment) => {
      const round = Number(judgment.metadata.id.split(':')[0]?.slice('m2-'.length))
      return successResult(judgment, probabilities[round] ?? 0)
    })
    const grader = createJevAxisGrader({ client: jev })
    const metrics = await grader.score(
      contextOf(
        variant(undefined, { round: 0 }),
        variant(undefined, { round: 1 }),
        variant(undefined, { round: 2 }),
      ),
    )

    const details = await grader.details?.(contextOf())
    expect(details).toHaveLength(15)
    expect(metrics['persona.consistency']).toBe(0.5)
    expect(metrics['objective.completion']).toBe(0.5)
  })
})

describe('Jev axis grader: code guardrails', () => {
  it('derives plain-text, emoji, Markdown and failure metrics from completed speech', async () => {
    const jev = fakeJev(0.875)
    const grader = createJevAxisGrader({ client: jev })
    const clean = variant(undefined, { round: 0, speech: speechMetrics(1, 1, 2) })
    const cleanToo = variant(undefined, { round: 1, speech: speechMetrics(1, 2, 0) })
    const mixed = variant(undefined, { round: 2, speech: speechMetrics(0.5, 0, 3) })
    const failed = variant(undefined, {
      round: 3,
      ok: false,
      error: 'provider down',
      speech: speechMetrics(0, 4, 4),
    })

    const metrics = await grader.score(contextOf(clean, cleanToo, mixed, failed))

    expect(jev.calls).toHaveLength(15)
    expect(metrics).toStrictEqual({
      'persona.consistency': 0.875,
      'language.quality': 0.875,
      'register.fit': 0.875,
      'response.clarity': 0.875,
      'objective.completion': 0.875,
      'response.plain_text_rate': 2 / 3,
      'response.emoji_count': 3,
      'response.markdown_count': 5,
      'run.failure_rate': 1 / 4,
    })
  })

  it('reports zero guardrail readings when no completed trial carries speech', async () => {
    const grader = createJevAxisGrader({ client: fakeJev(0.875) })
    const metrics = await grader.score(CONTEXT(trial(undefined)))

    expect(metrics['response.plain_text_rate']).toBe(0)
    expect(metrics['response.emoji_count']).toBe(0)
    expect(metrics['response.markdown_count']).toBe(0)
    expect(metrics['run.failure_rate']).toBe(0)
  })
})

describe('Jev axis grader: trial selection', () => {
  it('rejects a run with no completed session trial and asks Jev nothing', async () => {
    const jev = fakeJev()
    const grader = createJevAxisGrader({ client: jev })
    const replay = variant(undefined, {
      task: {
        ...task(undefined),
        mode: 'replay',
        session: undefined,
        content: { turns: [{ role: 'user', text: 'recorded turn' }] },
      },
    })
    const failed = variant(undefined, { ok: false, error: 'provider down' })

    const error = await rejection(grader.score(contextOf(replay, failed)))

    expect(error.message).toBe(
      'no completed session trial to grade; a semantic run has no evidence',
    )
    expect(jev.calls).toStrictEqual([])
  })

  it('grades only the completed session trial in a mixed trial list', async () => {
    const jev = fakeJev(0.875)
    const grader = createJevAxisGrader({ client: jev })
    const completed = variant(undefined, { round: 0 })
    const failed = variant(undefined, { round: 1, ok: false, error: 'provider down' })

    const metrics = await grader.score(contextOf(failed, completed))
    const details = await grader.details?.(CONTEXT(completed))

    expect(jev.calls).toHaveLength(5)
    expect(details?.map((detail) => detail.trialId)).toStrictEqual([
      '0:en:en-session-001',
      '0:en:en-session-001',
      '0:en:en-session-001',
      '0:en:en-session-001',
      '0:en:en-session-001',
    ])
    expect(metrics['run.failure_rate']).toBe(1 / 2)
  })

  it('skips a trial whose task was not loaded', async () => {
    const jev = fakeJev(0.875)
    const grader = createJevAxisGrader({ client: jev })
    const taskless = variant(undefined, { round: 9, task: undefined })
    const completed = variant(undefined, { round: 0 })

    const metrics = await grader.score(contextOf(taskless, completed))

    expect(jev.calls).toHaveLength(5)
    expect(metrics['run.failure_rate']).toBe(0)
  })
})

describe('Jev axis grader: Jev failures', () => {
  it('reports the trial id, axis and message and stops at the failed axis', async () => {
    const jev = stubJev((judgment) =>
      judgment.metadata.id.endsWith('-register.fit')
        ? failureResult(judgment, 'network down')
        : successResult(judgment, 0.875),
    )
    const grader = createJevAxisGrader({ client: jev })

    const error = await rejection(grader.score(CONTEXT(trial(undefined))))

    expect(error.message).toBe(
      'Jev call failed for 0:en:en-session-001/register.fit: network down; a failed call is not a "no"',
    )
    expect(jev.calls.map((call) => call.metadata.id)).toStrictEqual([
      'm2-0:en:en-session-001-persona.consistency',
      'm2-0:en:en-session-001-language.quality',
      'm2-0:en:en-session-001-register.fit',
    ])
    expect(await grader.details?.(CONTEXT(trial(undefined)))).toStrictEqual([])
  })

  it('rejects a non-boolean answer with the exact message', async () => {
    const choiceDistribution: JevDistribution = {
      kind: 'choice',
      choice: 'yes',
      probabilities: { yes: 1 },
    }
    const jev = stubJev((judgment) => ({
      ...successResult(judgment, 0.875),
      distribution: choiceDistribution,
    }))
    const grader = createJevAxisGrader({ client: jev })

    const error = await rejection(grader.score(CONTEXT(trial(undefined))))

    expect(error.message).toBe('Jev returned a non-boolean answer for a noul question')
  })

  it('rejects a noul answer with no yes probability', async () => {
    const jev = stubJev((judgment) => ({
      ...successResult(judgment, 0.875),
      distribution: { kind: 'noul' } as never,
    }))
    const grader = createJevAxisGrader({ client: jev })

    const error = await rejection(grader.score(CONTEXT(trial(undefined))))

    expect(error.message).toBe('Jev response has no yes probability')
  })

  it('rejects a yes probability that is not a number', async () => {
    const jev = stubJev((judgment) => ({
      ...successResult(judgment, 0.875),
      distribution: { kind: 'noul', probabilityYes: '0.9', probabilityNo: 0.1 } as never,
    }))
    const grader = createJevAxisGrader({ client: jev })

    const error = await rejection(grader.score(CONTEXT(trial(undefined))))

    expect(error.message).toBe('Jev response has no yes probability')
  })
})

describe('Jev axis grader: trial text', () => {
  it('builds the exact state from committed texts and the canonical locale copy', async () => {
    const jev = fakeJev(0.875)
    const grader = createJevAxisGrader({ client: jev })
    const candidate = variant('en-GB', {
      records: [
        recordAt(0, 'user.utterance.committed', { text: 'Could I have two more days?' }),
        recordAt(1, 'persona.utterance.partial', {
          grantId: 'g1',
          text: 'partial draft',
          sequence: 0,
        }),
        recordAt(2, 'user.utterance.committed', { text: 42 }),
        recordAt(3, 'persona.response.committed', {
          grantId: 'g1',
          text: 'How much time, and what is still missing?',
        }),
        recordAt(4, 'persona.response.committed', { grantId: 'g1', text: null }),
        recordAt(5, 'persona.response.committed', {
          grantId: 'g1',
          text: 'Send the headline figures on Friday.',
        }),
      ],
    })

    await grader.score(CONTEXT(candidate))

    expect(jev.calls[0]?.state).toStrictEqual({
      persona: {
        id: 'manager',
        role: 'Engineering manager',
        displayName: 'Katherine Brooks',
        voice: {
          tone: 'direct but understated, courteous, deadline-focused',
          formality: 'formal',
          warmth: 'medium',
          directness: 'medium',
          pace: 'measured',
        },
      },
      scenario: {
        id: 'request-deadline-extension',
        type: 'request-deadline-extension',
        setting:
          'A one-to-one progress check on a quarterly report that is due on Friday. The team uses British spelling and a relatively indirect register.',
        learnerRole: 'A junior analyst who reports to the manager.',
        objectives: [
          {
            id: 'ask-for-extension',
            description: 'Ask for a two-day extension clearly but politely.',
            successCriteria: [
              'States the request without over-apologising',
              'Gives a reason',
              'Names the revised deadline',
            ],
          },
          {
            id: 'offer-plan',
            description: 'Offer a practical interim deliverable.',
            successCriteria: [
              'Names the headline figures for Friday',
              'Names the full draft for Monday',
            ],
          },
          {
            id: 'confirm-agreement',
            description: 'Confirm the agreed plan before finishing.',
            successCriteria: ['Repeats the revised deadline', 'Confirms the manager agreed'],
          },
        ],
      },
      lang: 'en',
      locale: 'en-GB',
      learnerUtterances: ['Could I have two more days?'],
      personaReplies: [
        'How much time, and what is still missing?',
        'Send the headline figures on Friday.',
      ],
    })
  })

  it('rejects an unknown persona id', async () => {
    const grader = createJevAxisGrader({ client: fakeJev() })
    const broken = variant(undefined, {
      task: {
        ...task(undefined),
        session: { ...sessionBlock(task(undefined)), personaId: 'ghost' },
      },
    })

    await expect(grader.score(CONTEXT(broken))).rejects.toThrow('unknown persona "ghost"')
  })

  it('rejects an unknown scenario id', async () => {
    const grader = createJevAxisGrader({ client: fakeJev() })
    const broken = variant(undefined, {
      task: {
        ...task(undefined),
        session: { ...sessionBlock(task(undefined)), scenarioId: 'ghost' },
      },
    })

    await expect(grader.score(CONTEXT(broken))).rejects.toThrow('unknown scenario "ghost"')
  })
})
