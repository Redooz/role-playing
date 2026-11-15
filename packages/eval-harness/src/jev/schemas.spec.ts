import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { JEV_MODEL } from './constants.js'
import {
  formatZodIssues,
  jevAnswerSchema,
  jevBatchJudgmentSchema,
  jevChoiceAnswerSchema,
  jevChoiceQuestionSchema,
  jevJudgmentSchema,
  jevNoulAnswerSchema,
  jevNoulQuestionSchema,
  jevQuestionMetadataSchema,
  jevQuestionSchema,
  jevResponseSchema,
  jevScoreAnswerSchema,
  jevScoreQuestionSchema,
  jevStateSchema,
} from './schemas.js'

type ParseResult = { success: true; data: unknown } | { success: false; error: z.ZodError }

interface IssueShape {
  readonly code: string
  readonly path: readonly PropertyKey[]
  readonly message: string
}

function issuesOf(result: ParseResult): IssueShape[] {
  if (result.success) throw new Error('expected the schema to reject the input')
  return result.error.issues.map((issue) => ({
    code: issue.code,
    path: issue.path,
    message: issue.message,
  }))
}

const METADATA = {
  id: 'smoke-en-status-request',
  lang: 'en',
  rubricVersion: 'jev-smoke-rubric-v1',
  graderVersion: JEV_MODEL,
  extractionVersion: 'none',
}

const NOUL_QUESTION = {
  type: 'noul' as const,
  instructions: 'Does the utterance ask for a status update?',
  criteria: {
    true: 'It asks for the current status.',
    false: 'It does not ask for the current status.',
  },
}

const CHOICE_QUESTION = {
  type: 'choice' as const,
  instructions: 'Who should speak next?',
  criteria: { manager: 'The manager.', peer: 'The peer.' },
}

const SCORE_QUESTION = {
  type: 'score' as const,
  instructions: 'How polite is the reply?',
  criteria: ['Rude', 'Neutral', 'Polite'],
}

describe('jevQuestionMetadataSchema', () => {
  it('accepts the committed metadata shape unchanged when no locale is set', () => {
    const parsed = jevQuestionMetadataSchema.safeParse(METADATA)

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toStrictEqual(METADATA)
    expect(parsed.data).not.toHaveProperty('locale')
  })

  it('trims the id and the optional locale', () => {
    const parsed = jevQuestionMetadataSchema.safeParse({
      ...METADATA,
      id: '  smoke-en-status-request  ',
      locale: ' en-GB ',
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.id).toBe('smoke-en-status-request')
    expect(parsed.data.locale).toBe('en-GB')
  })

  it('strips fields the metadata schema does not model', () => {
    const parsed = jevQuestionMetadataSchema.safeParse({ ...METADATA, extra: 'dropped' })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toStrictEqual(METADATA)
  })

  it.each([
    [
      'a blank id',
      { id: '   ' },
      [
        {
          code: 'too_small',
          path: ['id'],
          message: 'Too small: expected string to have >=1 characters',
        },
      ],
    ],
    [
      'a language other than en/fr',
      { lang: 'de' },
      [
        {
          code: 'invalid_value',
          path: ['lang'],
          message: 'Invalid option: expected one of "en"|"fr"',
        },
      ],
    ],
    [
      'a blank locale',
      { locale: '' },
      [
        {
          code: 'too_small',
          path: ['locale'],
          message: 'Too small: expected string to have >=1 characters',
        },
      ],
    ],
    [
      'a blank rubric version',
      { rubricVersion: '' },
      [
        {
          code: 'too_small',
          path: ['rubricVersion'],
          message: 'Too small: expected string to have >=1 characters',
        },
      ],
    ],
    [
      'a grader that is not the pin',
      { graderVersion: 'typesafe/jev-1.15' },
      [
        {
          code: 'invalid_value',
          path: ['graderVersion'],
          message: `Invalid input: expected ${JSON.stringify(JEV_MODEL)}`,
        },
      ],
    ],
    [
      'a blank extraction version',
      { extractionVersion: '' },
      [
        {
          code: 'too_small',
          path: ['extractionVersion'],
          message: 'Too small: expected string to have >=1 characters',
        },
      ],
    ],
  ])('rejects %s', (_name, override, expected) => {
    const result = jevQuestionMetadataSchema.safeParse({ ...METADATA, ...override }) as ParseResult

    expect(issuesOf(result)).toStrictEqual(expected)
  })
})

describe('jevStateSchema', () => {
  it.each([
    ['plain text', 'a learner asks for time'],
    ['an object', { utterance: 'Could I have two more days?' }],
    ['an array', ['first turn', 'second turn']],
    ['a mixed array', [1, { turn: 2 }]],
  ])('accepts %s', (_name, state) => {
    const parsed = jevStateSchema.safeParse(state)

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toStrictEqual(state)
  })

  it.each([
    ['a number', 3],
    ['a boolean', true],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_name, state) => {
    const result = jevStateSchema.safeParse(state) as ParseResult

    expect(issuesOf(result)).toStrictEqual([
      { code: 'invalid_union', path: [], message: 'Invalid input' },
    ])
  })
})

describe('jevQuestionSchema', () => {
  it.each([
    ['noul', NOUL_QUESTION],
    ['choice', CHOICE_QUESTION],
    ['score', SCORE_QUESTION],
  ])('accepts a %s question', (_name, question) => {
    const parsed = jevQuestionSchema.safeParse(question)

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toStrictEqual(question)
  })

  it('requires both sides of a noul question', () => {
    const result = jevNoulQuestionSchema.safeParse({
      type: 'noul',
      instructions: 'Does it ask for a status update?',
      criteria: { true: 'It asks.' },
    }) as ParseResult

    expect(issuesOf(result)).toStrictEqual([
      {
        code: 'invalid_type',
        path: ['criteria', 'false'],
        message: 'Invalid input: expected string, received undefined',
      },
    ])
  })

  it.each([
    [
      'a blank noul instruction',
      jevNoulQuestionSchema,
      { ...NOUL_QUESTION, instructions: '' },
      [
        {
          code: 'too_small',
          path: ['instructions'],
          message: 'Too small: expected string to have >=1 characters',
        },
      ],
    ],
    [
      'a blank noul true criterion',
      jevNoulQuestionSchema,
      { ...NOUL_QUESTION, criteria: { true: '', false: 'It does not ask.' } },
      [
        {
          code: 'too_small',
          path: ['criteria', 'true'],
          message: 'Too small: expected string to have >=1 characters',
        },
      ],
    ],
    [
      'a blank choice criterion value',
      jevChoiceQuestionSchema,
      { ...CHOICE_QUESTION, criteria: { manager: '', peer: 'The peer.' } },
      [
        {
          code: 'too_small',
          path: ['criteria', 'manager'],
          message: 'Too small: expected string to have >=1 characters',
        },
      ],
    ],
    [
      'a score with one criterion',
      jevScoreQuestionSchema,
      { ...SCORE_QUESTION, criteria: ['Rude'] },
      [
        {
          code: 'too_small',
          path: ['criteria'],
          message: 'Too small: expected array to have >=2 items',
        },
      ],
    ],
    [
      'a blank score criterion',
      jevScoreQuestionSchema,
      { ...SCORE_QUESTION, criteria: ['Rude', ''] },
      [
        {
          code: 'too_small',
          path: ['criteria', 1],
          message: 'Too small: expected string to have >=1 characters',
        },
      ],
    ],
  ])('rejects %s', (_name, schema, input, expected) => {
    expect(issuesOf(schema.safeParse(input) as ParseResult)).toStrictEqual(expected)
  })

  it('rejects a question type the API does not model', () => {
    const result = jevQuestionSchema.safeParse({ type: 'verdict', instructions: 'Pick one.' })

    expect(issuesOf(result as ParseResult)).toStrictEqual([
      {
        code: 'invalid_union',
        path: ['type'],
        message: "Invalid discriminator value. Expected 'noul' | 'choice' | 'score'",
      },
    ])
  })
})

describe('jevJudgmentSchema', () => {
  it('accepts a noul judgment and keeps its metadata, state and question', () => {
    const judgment = {
      metadata: METADATA,
      state: 'Hi, where is the report?',
      question: NOUL_QUESTION,
    }

    const parsed = jevJudgmentSchema.safeParse(judgment)

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toStrictEqual(judgment)
  })

  it('accepts an object state and strips fields the schema does not model', () => {
    const parsed = jevJudgmentSchema.safeParse({
      metadata: METADATA,
      state: { utterance: 'Where is the report?' },
      question: CHOICE_QUESTION,
      extra: 'dropped',
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).not.toHaveProperty('extra')
  })

  it('rejects a choice question with fewer than two criteria', () => {
    const result = jevJudgmentSchema.safeParse({
      metadata: METADATA,
      state: 'Who speaks?',
      question: { ...CHOICE_QUESTION, criteria: { manager: 'The manager.' } },
    })

    expect(issuesOf(result as ParseResult)).toStrictEqual([
      {
        code: 'custom',
        path: ['question', 'criteria'],
        message: 'A choice question needs at least two criteria.',
      },
    ])
  })

  it('rejects a choice question with a blank criterion label', () => {
    const result = jevJudgmentSchema.safeParse({
      metadata: METADATA,
      state: 'Who speaks?',
      question: {
        ...CHOICE_QUESTION,
        criteria: { '   ': 'The invisible one.', peer: 'The peer.' },
      },
    })

    expect(issuesOf(result as ParseResult)).toStrictEqual([
      {
        code: 'custom',
        path: ['question', 'criteria'],
        message: 'Choice criteria labels must be non-empty.',
      },
    ])
  })

  it('does not apply the choice refinement to noul or score questions', () => {
    for (const question of [NOUL_QUESTION, SCORE_QUESTION]) {
      const parsed = jevJudgmentSchema.safeParse({ metadata: METADATA, state: 'text', question })

      expect(parsed.success).toBe(true)
    }
  })

  it('still reports the base question issue when a score has one criterion', () => {
    const result = jevJudgmentSchema.safeParse({
      metadata: METADATA,
      state: 'text',
      question: { ...SCORE_QUESTION, criteria: ['Rude'] },
    })

    expect(issuesOf(result as ParseResult)).toStrictEqual([
      {
        code: 'too_small',
        path: ['question', 'criteria'],
        message: 'Too small: expected array to have >=2 items',
      },
    ])
  })
})

describe('jevBatchJudgmentSchema', () => {
  it('accepts two questions that share one state', () => {
    const batch = {
      metadata: METADATA,
      state: 'Who speaks?',
      questions: { q1: NOUL_QUESTION, q2: CHOICE_QUESTION },
    }

    const parsed = jevBatchJudgmentSchema.safeParse(batch)

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toStrictEqual(batch)
  })

  it('trims question keys', () => {
    const parsed = jevBatchJudgmentSchema.safeParse({
      metadata: METADATA,
      state: 'text',
      questions: { ' q1 ': NOUL_QUESTION, q2: NOUL_QUESTION },
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(Object.keys(parsed.data.questions)).toStrictEqual(['q1', 'q2'])
  })

  it('rejects a blank question key', () => {
    const result = jevBatchJudgmentSchema.safeParse({
      metadata: METADATA,
      state: 'text',
      questions: { '  ': NOUL_QUESTION, q2: NOUL_QUESTION },
    })

    expect(issuesOf(result as ParseResult)).toStrictEqual([
      { code: 'invalid_key', path: ['questions', '  '], message: 'Invalid key in record' },
    ])
  })

  it('rejects a batch with fewer than two questions', () => {
    const result = jevBatchJudgmentSchema.safeParse({
      metadata: METADATA,
      state: 'text',
      questions: { q1: NOUL_QUESTION },
    })

    expect(issuesOf(result as ParseResult)).toStrictEqual([
      {
        code: 'custom',
        path: ['questions'],
        message: 'A batched judgment needs at least two questions.',
      },
    ])
  })

  it('rejects a choice question in the batch with fewer than two criteria', () => {
    const result = jevBatchJudgmentSchema.safeParse({
      metadata: METADATA,
      state: 'text',
      questions: {
        q1: NOUL_QUESTION,
        q2: { ...CHOICE_QUESTION, criteria: { manager: 'The manager.' } },
      },
    })

    expect(issuesOf(result as ParseResult)).toStrictEqual([
      {
        code: 'custom',
        path: ['questions', 'q2', 'criteria'],
        message: 'A choice question needs at least two criteria.',
      },
    ])
  })

  it('rejects a choice question in the batch with a blank criterion label', () => {
    const result = jevBatchJudgmentSchema.safeParse({
      metadata: METADATA,
      state: 'text',
      questions: {
        q1: NOUL_QUESTION,
        q2: { ...CHOICE_QUESTION, criteria: { ' ': 'The invisible one.', peer: 'The peer.' } },
      },
    })

    expect(issuesOf(result as ParseResult)).toStrictEqual([
      {
        code: 'custom',
        path: ['questions', 'q2', 'criteria'],
        message: 'Choice criteria labels must be non-empty.',
      },
    ])
  })

  it('reports the batch-size issue and the per-question issue together, in order', () => {
    const result = jevBatchJudgmentSchema.safeParse({
      metadata: METADATA,
      state: 'text',
      questions: { q1: { ...CHOICE_QUESTION, criteria: { only: 'One option.' } } },
    })

    expect(issuesOf(result as ParseResult)).toStrictEqual([
      {
        code: 'custom',
        path: ['questions'],
        message: 'A batched judgment needs at least two questions.',
      },
      {
        code: 'custom',
        path: ['questions', 'q1', 'criteria'],
        message: 'A choice question needs at least two criteria.',
      },
    ])
  })

  it('does not apply the choice refinement to noul questions in the batch', () => {
    const parsed = jevBatchJudgmentSchema.safeParse({
      metadata: METADATA,
      state: 'text',
      questions: { q1: NOUL_QUESTION, q2: NOUL_QUESTION },
    })

    expect(parsed.success).toBe(true)
  })
})

describe('answer schemas', () => {
  it.each([0, 0.5, 1])('accepts a noul probability of %s', (noul) => {
    const parsed = jevNoulAnswerSchema.safeParse({ type: 'noul', noul })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toStrictEqual({ type: 'noul', noul })
  })

  it.each([
    [
      -0.1,
      [{ code: 'too_small', path: ['noul'], message: 'Too small: expected number to be >=0' }],
    ],
    [1.1, [{ code: 'too_big', path: ['noul'], message: 'Too big: expected number to be <=1' }]],
    [
      Number.NaN,
      [
        {
          code: 'invalid_type',
          path: ['noul'],
          message: 'Invalid input: expected number, received NaN',
        },
      ],
    ],
    [
      Number.POSITIVE_INFINITY,
      [
        {
          code: 'invalid_type',
          path: ['noul'],
          message: 'Invalid input: expected number, received Infinity',
        },
      ],
    ],
  ])('rejects the out-of-range noul probability %s', (noul, expected) => {
    expect(
      issuesOf(jevNoulAnswerSchema.safeParse({ type: 'noul', noul }) as ParseResult),
    ).toStrictEqual(expected)
  })

  it('accepts a choice answer with probabilities and confidence', () => {
    const parsed = jevChoiceAnswerSchema.safeParse({
      type: 'choice',
      choice: 'peer',
      probabilities: { peer: 0.8, manager: 0.2 },
      confidence: 1,
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toStrictEqual({
      type: 'choice',
      choice: 'peer',
      probabilities: { peer: 0.8, manager: 0.2 },
      confidence: 1,
    })
  })

  it.each([
    [
      'a blank choice',
      { type: 'choice', choice: '', probabilities: { peer: 1 } },
      [
        {
          code: 'too_small',
          path: ['choice'],
          message: 'Too small: expected string to have >=1 characters',
        },
      ],
    ],
    [
      'a probability above one',
      { type: 'choice', choice: 'peer', probabilities: { peer: 1.2 } },
      [
        {
          code: 'too_big',
          path: ['probabilities', 'peer'],
          message: 'Too big: expected number to be <=1',
        },
      ],
    ],
    [
      'a confidence above one',
      { type: 'choice', choice: 'peer', probabilities: { peer: 1 }, confidence: 1.5 },
      [{ code: 'too_big', path: ['confidence'], message: 'Too big: expected number to be <=1' }],
    ],
  ])('rejects %s', (_name, input, expected) => {
    expect(issuesOf(jevChoiceAnswerSchema.safeParse(input) as ParseResult)).toStrictEqual(expected)
  })

  it('accepts a score answer with a legend and a negative score', () => {
    const parsed = jevScoreAnswerSchema.safeParse({
      type: 'score',
      score: -1,
      probabilities: { '0': 0.5, '1': 0.5 },
      confidence: 0.4,
      legend: { '0': 'Rude', '1': 'Polite' },
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toStrictEqual({
      type: 'score',
      score: -1,
      probabilities: { '0': 0.5, '1': 0.5 },
      confidence: 0.4,
      legend: { '0': 'Rude', '1': 'Polite' },
    })
  })

  it.each([
    [
      'a non-finite score',
      { type: 'score', score: Number.POSITIVE_INFINITY, probabilities: { '0': 1 } },
      [
        {
          code: 'invalid_type',
          path: ['score'],
          message: 'Invalid input: expected number, received Infinity',
        },
      ],
    ],
    [
      'a blank legend entry',
      { type: 'score', score: 1, probabilities: { '0': 1 }, legend: { '0': '' } },
      [
        {
          code: 'too_small',
          path: ['legend', '0'],
          message: 'Too small: expected string to have >=1 characters',
        },
      ],
    ],
  ])('rejects %s', (_name, input, expected) => {
    expect(issuesOf(jevScoreAnswerSchema.safeParse(input) as ParseResult)).toStrictEqual(expected)
  })

  it('rejects an answer type the API does not model', () => {
    const result = jevAnswerSchema.safeParse({ type: 'verdict', verdict: 'yes' })

    expect(issuesOf(result as ParseResult)).toStrictEqual([
      {
        code: 'invalid_union',
        path: ['type'],
        message: "Invalid discriminator value. Expected 'noul' | 'choice' | 'score'",
      },
    ])
  })
})

describe('jevResponseSchema', () => {
  const USAGE = { input_tokens: 10, output_tokens: 2 }

  it('accepts a minimal response and strips unknown top-level fields', () => {
    const parsed = jevResponseSchema.safeParse({
      model: JEV_MODEL,
      answers: {},
      usage: USAGE,
      extra: 'dropped',
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toStrictEqual({ model: JEV_MODEL, answers: {}, usage: USAGE })
  })

  it('keeps the optional envelope fields', () => {
    const response = {
      model: 'typesafe/jev-1.14-20261014',
      answers: { q1: { type: 'noul', noul: 0.5 } },
      usage: { ...USAGE, cost: 0.00002 },
      id: 'gen-1',
      provider: 'TypeSafe',
    }

    const parsed = jevResponseSchema.safeParse(response)

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toStrictEqual(response)
  })

  it.each([
    [
      'a blank model',
      { model: '', answers: {}, usage: USAGE },
      [
        {
          code: 'too_small',
          path: ['model'],
          message: 'Too small: expected string to have >=1 characters',
        },
      ],
    ],
    [
      'a fractional token count',
      { model: JEV_MODEL, answers: {}, usage: { input_tokens: 1.5, output_tokens: 2 } },
      [
        {
          code: 'invalid_type',
          path: ['usage', 'input_tokens'],
          message: 'Invalid input: expected int, received number',
        },
      ],
    ],
    [
      'a negative token count',
      { model: JEV_MODEL, answers: {}, usage: { input_tokens: 1, output_tokens: -1 } },
      [
        {
          code: 'too_small',
          path: ['usage', 'output_tokens'],
          message: 'Too small: expected number to be >=0',
        },
      ],
    ],
    [
      'a negative cost',
      {
        model: JEV_MODEL,
        answers: {},
        usage: { input_tokens: 1, output_tokens: 2, cost: -0.1 },
      },
      [
        {
          code: 'too_small',
          path: ['usage', 'cost'],
          message: 'Too small: expected number to be >=0',
        },
      ],
    ],
  ])('rejects %s', (_name, input, expected) => {
    expect(issuesOf(jevResponseSchema.safeParse(input) as ParseResult)).toStrictEqual(expected)
  })

  it('reports every missing envelope field at once', () => {
    expect(issuesOf(jevResponseSchema.safeParse({}) as ParseResult)).toStrictEqual([
      {
        code: 'invalid_type',
        path: ['model'],
        message: 'Invalid input: expected string, received undefined',
      },
      {
        code: 'invalid_type',
        path: ['answers'],
        message: 'Invalid input: expected record, received undefined',
      },
      {
        code: 'invalid_type',
        path: ['usage'],
        message: 'Invalid input: expected object, received undefined',
      },
    ])
  })
})

describe('formatZodIssues', () => {
  it('prefixes each issue with its dotted path', () => {
    const result = jevResponseSchema.safeParse({ model: '', answers: {}, usage: {} })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(formatZodIssues(result.error)).toStrictEqual([
      'model: Too small: expected string to have >=1 characters',
      'usage.input_tokens: Invalid input: expected number, received undefined',
      'usage.output_tokens: Invalid input: expected number, received undefined',
    ])
  })

  it('renders a root issue without a path as <root>', () => {
    const result = jevStateSchema.safeParse(42)

    expect(result.success).toBe(false)
    if (result.success) return
    expect(formatZodIssues(result.error)).toStrictEqual(['<root>: Invalid input'])
  })

  it('renders array indexes as string path segments', () => {
    const result = jevScoreQuestionSchema.safeParse({ ...SCORE_QUESTION, criteria: ['Rude', ''] })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(formatZodIssues(result.error)).toStrictEqual([
      'criteria.1: Too small: expected string to have >=1 characters',
    ])
  })

  it('returns an empty list for an error with no issues', () => {
    expect(formatZodIssues(new z.ZodError([]))).toStrictEqual([])
  })
})
