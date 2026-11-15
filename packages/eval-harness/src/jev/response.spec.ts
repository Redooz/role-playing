import { describe, expect, it } from 'vitest'
import { JEV_MODEL } from './constants.js'
import { JevInvalidResponseError } from './errors.js'
import {
  assertPinnedServedModel,
  parseJevAnswerForQuestion,
  parseJevAnswersForQuestions,
  parseJevResponse,
} from './response.js'
import type { JevAnswer, JevQuestion } from './types.js'

const NOUL_QUESTION: JevQuestion = {
  type: 'noul',
  instructions: 'Is this a request?',
  criteria: { true: 'It asks for something.', false: 'It asks for nothing.' },
}

const CHOICE_QUESTION: JevQuestion = {
  type: 'choice',
  instructions: 'Who should speak next?',
  criteria: { manager: 'The manager.', peer: 'The peer.' },
}

const SCORE_QUESTION: JevQuestion = {
  type: 'score',
  instructions: 'How polite is the reply?',
  criteria: ['Rude', 'Neutral', 'Polite'],
}

function response(answers: Readonly<Record<string, JevAnswer>>, model: string = JEV_MODEL) {
  return {
    model,
    answers,
    usage: { input_tokens: 41, output_tokens: 7 },
  }
}

function expectInvalidResponse(run: () => unknown): JevInvalidResponseError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(JevInvalidResponseError)
    const invalid = error as JevInvalidResponseError
    expect(invalid.name).toBe('JevInvalidResponseError')
    expect(invalid.code).toBe('jev_invalid_response')
    return invalid
  }
  throw new Error('expected the call to throw')
}

describe('parseJevResponse', () => {
  it('returns a noul answer and strips fields the schema does not model', () => {
    const parsed = parseJevResponse({
      model: JEV_MODEL,
      answers: { q1: { type: 'noul', noul: 0.5, note: 'dropped' } },
      usage: { input_tokens: 3, output_tokens: 4 },
      unknown_field: true,
    })

    expect(parsed).toStrictEqual({
      model: JEV_MODEL,
      answers: { q1: { type: 'noul', noul: 0.5 } },
      usage: { input_tokens: 3, output_tokens: 4 },
    })
    expect(parsed).not.toHaveProperty('unknown_field')
    expect(parsed.answers.q1).not.toHaveProperty('note')
  })

  it('returns choice and score answers with every optional envelope field', () => {
    const parsed = parseJevResponse({
      model: JEV_MODEL,
      answers: {
        n: { type: 'noul', noul: 0.25 },
        c: { type: 'choice', choice: 'a', probabilities: { a: 0.4, b: 0.6 }, confidence: 0.5 },
        s: {
          type: 'score',
          score: 1,
          probabilities: { '0': 0.2, '1': 0.8 },
          confidence: 0.7,
          legend: { '0': 'low', '1': 'high' },
        },
      },
      usage: { input_tokens: 5, output_tokens: 6, cost: 0.125 },
      id: 'gen-1',
      provider: 'TypeSafe',
    })

    expect(parsed).toStrictEqual({
      model: JEV_MODEL,
      answers: {
        n: { type: 'noul', noul: 0.25 },
        c: { type: 'choice', choice: 'a', probabilities: { a: 0.4, b: 0.6 }, confidence: 0.5 },
        s: {
          type: 'score',
          score: 1,
          probabilities: { '0': 0.2, '1': 0.8 },
          confidence: 0.7,
          legend: { '0': 'low', '1': 'high' },
        },
      },
      usage: { input_tokens: 5, output_tokens: 6, cost: 0.125 },
      id: 'gen-1',
      provider: 'TypeSafe',
    })
  })

  it('rejects a response that does not match the schema with the exact message and issues', () => {
    const error = expectInvalidResponse(() =>
      parseJevResponse({ model: '', answers: { q1: { type: 'noul' } }, usage: {} }),
    )

    expect(error.message).toBe('Jev response did not match the Decisions response schema.')
    expect(error.details).toStrictEqual([
      'model: Too small: expected string to have >=1 characters',
      'answers.q1.noul: Invalid input: expected number, received undefined',
      'usage.input_tokens: Invalid input: expected number, received undefined',
      'usage.output_tokens: Invalid input: expected number, received undefined',
    ])
    expect(error.cause).toBeUndefined()
  })

  it('reports a root issue when the raw response is not an object', () => {
    const error = expectInvalidResponse(() => parseJevResponse(null))

    expect(error.message).toBe('Jev response did not match the Decisions response schema.')
    expect(error.details).toStrictEqual(['<root>: Invalid input: expected object, received null'])
    expect(error.cause).toBeUndefined()
  })

  it('rejects an answer type the schema does not model', () => {
    const error = expectInvalidResponse(() =>
      parseJevResponse({
        model: JEV_MODEL,
        answers: { q1: { type: 'verdict', verdict: 'yes' } },
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    )

    expect(error.message).toBe('Jev response did not match the Decisions response schema.')
    expect(error.details).toStrictEqual([
      "answers.q1.type: Invalid discriminator value. Expected 'noul' | 'choice' | 'score'",
    ])
  })
})

describe('assertPinnedServedModel', () => {
  it('accepts the exact pin and a dated snapshot of the pin', () => {
    expect(() => assertPinnedServedModel(JEV_MODEL)).not.toThrow()
    expect(() => assertPinnedServedModel(`${JEV_MODEL}-20261014`)).not.toThrow()
  })

  it('rejects another model with the exact pinned message', () => {
    const error = expectInvalidResponse(() => assertPinnedServedModel('typesafe/jev-1.13-20260917'))

    expect(error.message).toBe(
      'Jev served "typesafe/jev-1.13-20260917", but this package is pinned to typesafe/jev-1.14.',
    )
    expect(error.details).toStrictEqual([])
  })

  it('rejects an empty served model', () => {
    const error = expectInvalidResponse(() => assertPinnedServedModel(''))

    expect(error.message).toBe('Jev served "", but this package is pinned to typesafe/jev-1.14.')
  })

  it('quotes the served model with JSON.stringify', () => {
    const served = 'jev"1.14'

    const error = expectInvalidResponse(() => assertPinnedServedModel(served))

    expect(error.message).toBe(
      `Jev served ${JSON.stringify(served)}, but this package is pinned to ${JEV_MODEL}.`,
    )
  })
})

describe('parseJevAnswerForQuestion', () => {
  it('returns the noul answer and the complementary distribution', () => {
    const raw = response({ q1: { type: 'noul', noul: 0.8 } })

    const parsed = parseJevAnswerForQuestion(raw, 'q1', NOUL_QUESTION)

    expect(parsed.response).toStrictEqual(raw)
    expect(parsed.answer).toBe(parsed.response.answers.q1)
    expect(parsed.distribution.kind).toBe('noul')
    if (parsed.distribution.kind !== 'noul') throw new Error('expected a noul distribution')
    expect(parsed.distribution.probabilityYes).toBe(0.8)
    expect(parsed.distribution.probabilityNo).toBeCloseTo(0.2, 12)
  })

  it('returns a choice distribution with a copied probability map and confidence', () => {
    const raw = response({
      q1: {
        type: 'choice',
        choice: 'peer',
        probabilities: { peer: 0.75, manager: 0.25 },
        confidence: 0.9,
      },
    })

    const parsed = parseJevAnswerForQuestion(raw, 'q1', CHOICE_QUESTION)

    expect(parsed.distribution).toStrictEqual({
      kind: 'choice',
      choice: 'peer',
      probabilities: { peer: 0.75, manager: 0.25 },
      confidence: 0.9,
    })
    const answer = parsed.response.answers.q1
    if (answer?.type !== 'choice') throw new Error('expected a choice answer')
    if (parsed.distribution.kind !== 'choice') throw new Error('expected a choice distribution')
    expect(parsed.distribution.probabilities).not.toBe(answer.probabilities)
  })

  it('omits confidence from a choice distribution that has none', () => {
    const raw = response({
      q1: { type: 'choice', choice: 'manager', probabilities: { manager: 1, peer: 0 } },
    })

    const parsed = parseJevAnswerForQuestion(raw, 'q1', CHOICE_QUESTION)

    expect(parsed.distribution).toStrictEqual({
      kind: 'choice',
      choice: 'manager',
      probabilities: { manager: 1, peer: 0 },
    })
    expect(parsed.distribution).not.toHaveProperty('confidence')
  })

  it('returns a score distribution with copied probabilities, confidence and legend', () => {
    const raw = response({
      q1: {
        type: 'score',
        score: 2,
        probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 },
        confidence: 0.65,
        legend: { '0': 'Rude', '1': 'Neutral', '2': 'Polite' },
      },
    })

    const parsed = parseJevAnswerForQuestion(raw, 'q1', SCORE_QUESTION)

    expect(parsed.distribution).toStrictEqual({
      kind: 'score',
      score: 2,
      probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 },
      confidence: 0.65,
      legend: { '0': 'Rude', '1': 'Neutral', '2': 'Polite' },
    })
    const answer = parsed.response.answers.q1
    if (answer?.type !== 'score') throw new Error('expected a score answer')
    if (parsed.distribution.kind !== 'score') throw new Error('expected a score distribution')
    expect(parsed.distribution.probabilities).not.toBe(answer.probabilities)
    expect(parsed.distribution.legend).not.toBe(answer.legend)
  })

  it('omits confidence and legend from a score distribution that has none', () => {
    const raw = response({
      q1: { type: 'score', score: 0, probabilities: { '0': 0.5, '1': 0.5, '2': 0 } },
    })

    const parsed = parseJevAnswerForQuestion(raw, 'q1', SCORE_QUESTION)

    expect(parsed.distribution).toStrictEqual({
      kind: 'score',
      score: 0,
      probabilities: { '0': 0.5, '1': 0.5, '2': 0 },
    })
    expect(parsed.distribution).not.toHaveProperty('confidence')
    expect(parsed.distribution).not.toHaveProperty('legend')
  })

  it('rejects zero answers', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(response({}), 'q1', NOUL_QUESTION),
    )

    expect(error.message).toBe('Expected exactly one answer for one question, received 0.')
  })

  it('rejects two answers', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(
        response({
          q1: { type: 'noul', noul: 0.5 },
          q2: { type: 'noul', noul: 0.5 },
        }),
        'q1',
        NOUL_QUESTION,
      ),
    )

    expect(error.message).toBe('Expected exactly one answer for one question, received 2.')
  })

  it('rejects an answer for another question id', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(
        response({ other: { type: 'noul', noul: 0.5 } }),
        'q1',
        NOUL_QUESTION,
      ),
    )

    expect(error.message).toBe('Jev answered question "other" instead of "q1".')
  })

  it('rejects a noul answer for a choice question', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(
        response({ q1: { type: 'noul', noul: 0.5 } }),
        'q1',
        CHOICE_QUESTION,
      ),
    )

    expect(error.message).toBe('Jev returned a "noul" answer for a "choice" question.')
  })

  it('rejects a choice answer for a score question', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(
        response({
          q1: { type: 'choice', choice: 'manager', probabilities: { manager: 0.5, peer: 0.5 } },
        }),
        'q1',
        SCORE_QUESTION,
      ),
    )

    expect(error.message).toBe('Jev returned a "choice" answer for a "score" question.')
  })

  it('rejects a score answer for a noul question', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(
        response({
          q1: { type: 'score', score: 1, probabilities: { '0': 0.5, '1': 0.5 } },
        }),
        'q1',
        NOUL_QUESTION,
      ),
    )

    expect(error.message).toBe('Jev returned a "score" answer for a "noul" question.')
  })

  it('rejects a choice distribution missing a criterion key', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(
        response({
          q1: { type: 'choice', choice: 'manager', probabilities: { manager: 1 } },
        }),
        'q1',
        CHOICE_QUESTION,
      ),
    )

    expect(error.message).toBe('Jev returned an incomplete choice probabilities distribution.')
    expect(error.details).toStrictEqual([
      'expected keys [manager, peer]',
      'received keys [manager]',
    ])
  })

  it('rejects a choice distribution with an unexpected key of the same count', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(
        response({
          q1: {
            type: 'choice',
            choice: 'manager',
            probabilities: { manager: 0.5, supervisor: 0.5 },
          },
        }),
        'q1',
        CHOICE_QUESTION,
      ),
    )

    expect(error.message).toBe('Jev returned an incomplete choice probabilities distribution.')
    expect(error.details).toStrictEqual([
      'expected keys [manager, peer]',
      'received keys [manager, supervisor]',
    ])
  })

  it('rejects choice probabilities that do not sum to one', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(
        response({
          q1: { type: 'choice', choice: 'manager', probabilities: { manager: 0.5, peer: 0.3 } },
        }),
        'q1',
        CHOICE_QUESTION,
      ),
    )

    expect(error.message).toBe('Jev returned choice probabilities that sum to 0.8, not 1.')
  })

  it('rejects choice probabilities that sum to zero', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(
        response({
          q1: { type: 'choice', choice: 'manager', probabilities: { manager: 0, peer: 0 } },
        }),
        'q1',
        CHOICE_QUESTION,
      ),
    )

    expect(error.message).toBe('Jev returned choice probabilities that sum to 0, not 1.')
  })

  it('accepts choice probabilities exactly one and within the tolerance', () => {
    expect(() =>
      parseJevAnswerForQuestion(
        response({
          q1: { type: 'choice', choice: 'peer', probabilities: { manager: 0.25, peer: 0.75 } },
        }),
        'q1',
        CHOICE_QUESTION,
      ),
    ).not.toThrow()

    expect(() =>
      parseJevAnswerForQuestion(
        response({
          q1: { type: 'choice', choice: 'peer', probabilities: { manager: 0.5005, peer: 0.5 } },
        }),
        'q1',
        CHOICE_QUESTION,
      ),
    ).not.toThrow()
  })

  it('rejects choice probabilities outside the tolerance', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(
        response({
          q1: { type: 'choice', choice: 'peer', probabilities: { manager: 0.502, peer: 0.5 } },
        }),
        'q1',
        CHOICE_QUESTION,
      ),
    )

    expect(error.message).toBe('Jev returned choice probabilities that sum to 1.002, not 1.')
  })

  it('rejects a negative probability at the schema boundary', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(
        response({
          q1: { type: 'choice', choice: 'manager', probabilities: { manager: -0.2, peer: 1.2 } },
        }),
        'q1',
        CHOICE_QUESTION,
      ),
    )

    expect(error.message).toBe('Jev response did not match the Decisions response schema.')
    expect(error.details).toStrictEqual([
      'answers.q1.probabilities.manager: Too small: expected number to be >=0',
      'answers.q1.probabilities.peer: Too big: expected number to be <=1',
    ])
  })

  it('rejects a choice that is not in its own distribution', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(
        response({
          q1: {
            type: 'choice',
            choice: 'engineer',
            probabilities: { manager: 0.5, peer: 0.5 },
          },
        }),
        'q1',
        CHOICE_QUESTION,
      ),
    )

    expect(error.message).toBe(
      'Choice answer "engineer" is not present in its probability distribution.',
    )
  })

  it('rejects a score distribution whose keys are not the criteria indexes', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(
        response({
          q1: { type: 'score', score: 1, probabilities: { '0': 0.5, '1': 0.5 } },
        }),
        'q1',
        SCORE_QUESTION,
      ),
    )

    expect(error.message).toBe('Jev returned an incomplete score probabilities distribution.')
    expect(error.details).toStrictEqual(['expected keys [0, 1, 2]', 'received keys [0, 1]'])
  })

  it('rejects score probabilities that do not sum to one', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(
        response({
          q1: { type: 'score', score: 1, probabilities: { '0': 0.2, '1': 0.3, '2': 0.4 } },
        }),
        'q1',
        SCORE_QUESTION,
      ),
    )

    expect(error.message).toBe('Jev returned score probabilities that sum to 0.9, not 1.')
  })

  it('rejects a score legend whose keys do not match the distribution', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(
        response({
          q1: {
            type: 'score',
            score: 2,
            probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 },
            legend: { '0': 'Rude', '2': 'Polite' },
          },
        }),
        'q1',
        SCORE_QUESTION,
      ),
    )

    expect(error.message).toBe('Jev returned an incomplete score legend distribution.')
    expect(error.details).toStrictEqual(['expected keys [0, 1, 2]', 'received keys [0, 2]'])
  })

  it('rejects a response served by another model before checking the answer', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion(
        response({ q1: { type: 'noul', noul: 0.5 } }, 'typesafe/jev-1.13-20260917'),
        'q1',
        NOUL_QUESTION,
      ),
    )

    expect(error.message).toBe(
      'Jev served "typesafe/jev-1.13-20260917", but this package is pinned to typesafe/jev-1.14.',
    )
  })

  it('rejects a raw response that does not match the schema', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswerForQuestion({ model: JEV_MODEL }, 'q1', NOUL_QUESTION),
    )

    expect(error.message).toBe('Jev response did not match the Decisions response schema.')
    expect(error.details).toStrictEqual([
      'answers: Invalid input: expected record, received undefined',
      'usage: Invalid input: expected object, received undefined',
    ])
  })
})

describe('parseJevAnswersForQuestions', () => {
  it('accepts an empty question set with an empty answer set', () => {
    const raw = response({})

    const parsed = parseJevAnswersForQuestions(raw, {})

    expect(parsed.response).toStrictEqual(raw)
    expect(parsed.answers).toStrictEqual({})
    expect(parsed.distributions).toStrictEqual({})
  })

  it('returns one answer and one distribution for a single question', () => {
    const raw = response({ q1: { type: 'noul', noul: 0.5 } })

    const parsed = parseJevAnswersForQuestions(raw, { q1: NOUL_QUESTION })

    expect(parsed.answers).toStrictEqual({ q1: { type: 'noul', noul: 0.5 } })
    expect(parsed.answers.q1).toBe(parsed.response.answers.q1)
    expect(parsed.distributions).toStrictEqual({
      q1: { kind: 'noul', probabilityYes: 0.5, probabilityNo: 0.5 },
    })
  })

  it('returns every distribution when answers arrive in another key order', () => {
    const raw = response({
      q3: { type: 'score', score: 2, probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 } },
      q1: { type: 'noul', noul: 0.5 },
      q2: { type: 'choice', choice: 'peer', probabilities: { peer: 0.9, manager: 0.1 } },
    })

    const parsed = parseJevAnswersForQuestions(raw, {
      q1: NOUL_QUESTION,
      q2: CHOICE_QUESTION,
      q3: SCORE_QUESTION,
    })

    expect(Object.keys(parsed.distributions)).toStrictEqual(['q1', 'q2', 'q3'])
    expect(
      Object.values(parsed.distributions).map((distribution) => distribution.kind),
    ).toStrictEqual(['noul', 'choice', 'score'])
    expect(parsed.distributions.q3).toStrictEqual({
      kind: 'score',
      score: 2,
      probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 },
    })
    expect(parsed.response).toStrictEqual(raw)
  })

  it('accepts a question set whose keys are not in sorted order', () => {
    const raw = response({
      q1: { type: 'noul', noul: 0.5 },
      q2: { type: 'noul', noul: 0.5 },
    })

    const parsed = parseJevAnswersForQuestions(raw, { q2: NOUL_QUESTION, q1: NOUL_QUESTION })

    expect(Object.keys(parsed.distributions)).toStrictEqual(['q2', 'q1'])
  })

  it('rejects an extra answer', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswersForQuestions(
        response({
          q1: { type: 'noul', noul: 0.5 },
          q2: { type: 'noul', noul: 0.5 },
        }),
        { q1: NOUL_QUESTION },
      ),
    )

    expect(error.message).toBe('Jev returned an incomplete answer distribution.')
    expect(error.details).toStrictEqual(['expected keys [q1]', 'received keys [q1, q2]'])
  })

  it('rejects a missing answer', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswersForQuestions(response({ q1: { type: 'noul', noul: 0.5 } }), {
        q1: NOUL_QUESTION,
        q2: NOUL_QUESTION,
      }),
    )

    expect(error.message).toBe('Jev returned an incomplete answer distribution.')
    expect(error.details).toStrictEqual(['expected keys [q1, q2]', 'received keys [q1]'])
  })

  it('rejects a wrong answer key with the same count', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswersForQuestions(response({ other: { type: 'noul', noul: 0.5 } }), {
        q1: NOUL_QUESTION,
      }),
    )

    expect(error.message).toBe('Jev returned an incomplete answer distribution.')
    expect(error.details).toStrictEqual(['expected keys [q1]', 'received keys [other]'])
  })

  it('rejects a partial batch', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswersForQuestions(response({ q1: { type: 'noul', noul: 0.5 } }), {
        q1: NOUL_QUESTION,
        q2: CHOICE_QUESTION,
      }),
    )

    expect(error.message).toBe('Jev returned an incomplete answer distribution.')
    expect(error.details).toStrictEqual(['expected keys [q1, q2]', 'received keys [q1]'])
  })

  it('rejects a batch answer whose type does not match its question', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswersForQuestions(
        response({
          q1: { type: 'noul', noul: 0.5 },
          q2: { type: 'noul', noul: 0.5 },
        }),
        { q1: NOUL_QUESTION, q2: CHOICE_QUESTION },
      ),
    )

    expect(error.message).toBe('Jev returned a "noul" answer for a "choice" question.')
  })

  it('rejects an undefined question value', () => {
    const questions = { q1: undefined } as unknown as Readonly<Record<string, JevQuestion>>

    const error = expectInvalidResponse(() =>
      parseJevAnswersForQuestions(response({ q1: { type: 'noul', noul: 0.5 } }), questions),
    )

    expect(error.message).toBe('Jev returned no answer for question "q1".')
  })

  it('fails loudly on a question type the reducer cannot handle', () => {
    const bogus = { type: 'bogus' } as unknown as JevQuestion

    let caught: unknown
    try {
      parseJevAnswersForQuestions(response({ q1: { type: 'noul', noul: 0.5 } }), { q1: bogus })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(JevInvalidResponseError)
    expect((caught as Error).message).toBe('Unhandled Jev value: {"type":"bogus"}')
  })

  it('rejects a batch served by another model', () => {
    const error = expectInvalidResponse(() =>
      parseJevAnswersForQuestions(
        response({ q1: { type: 'noul', noul: 0.5 } }, 'typesafe/jev-1.13-20260917'),
        { q1: NOUL_QUESTION },
      ),
    )

    expect(error.message).toBe(
      'Jev served "typesafe/jev-1.13-20260917", but this package is pinned to typesafe/jev-1.14.',
    )
  })
})
