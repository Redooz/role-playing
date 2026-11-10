import { JEV_MODEL, isPinnedServedModel } from './constants.js'
import { JevInvalidResponseError } from './errors.js'
import { formatZodIssues, jevResponseSchema } from './schemas.js'
import type { JevAnswer, JevDistribution, JevQuestion, JevResponse } from './types.js'

export interface ParsedJevAnswer {
  readonly response: JevResponse
  readonly answer: JevAnswer
  readonly distribution: JevDistribution
}

export interface ParsedJevAnswers {
  readonly response: JevResponse
  readonly answers: Readonly<Record<string, JevAnswer>>
  readonly distributions: Readonly<Record<string, JevDistribution>>
}

/** Parse and shape-validate the raw Decisions response. */
export function parseJevResponse(raw: unknown): JevResponse {
  const parsed = jevResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new JevInvalidResponseError('Jev response did not match the Decisions response schema.', {
      details: formatZodIssues(parsed.error),
    })
  }
  return parsed.data
}

/** A response from another model is not a valid answer to a pinned-model judgment. */
export function assertPinnedServedModel(model: string): void {
  if (!isPinnedServedModel(model)) {
    throw new JevInvalidResponseError(
      `Jev served ${JSON.stringify(model)}, but this package is pinned to ${JEV_MODEL}.`,
    )
  }
}

/**
 * Validate the single answer for the single question sent, then normalize the
 * probability distribution. Missing, extra, mismatched, or partial
 * distributions are rejected rather than defaulted.
 */
export function parseJevAnswerForQuestion(
  raw: unknown,
  questionId: string,
  question: JevQuestion,
): ParsedJevAnswer {
  const response = parseJevResponse(raw)
  assertPinnedServedModel(response.model)

  const entries = Object.entries(response.answers)
  if (entries.length !== 1) {
    throw new JevInvalidResponseError(
      `Expected exactly one answer for one question, received ${entries.length}.`,
    )
  }

  const entry = entries[0]
  if (entry === undefined) {
    throw new JevInvalidResponseError('Jev returned no answer.')
  }
  const [answerId, answer] = entry
  if (answerId !== questionId) {
    throw new JevInvalidResponseError(
      `Jev answered question ${JSON.stringify(answerId)} instead of ${JSON.stringify(questionId)}.`,
    )
  }

  assertAnswerMatchesQuestion(answer, question)

  return {
    response,
    answer,
    distribution: toDistribution(answer),
  }
}

/**
 * Validate a batched response against the exact question set that was sent.
 *
 * Every expected answer must be present, no extra answer may appear, and each
 * distribution must match its question type. A partial batch is invalid.
 */
export function parseJevAnswersForQuestions(
  raw: unknown,
  questions: Readonly<Record<string, JevQuestion>>,
): ParsedJevAnswers {
  const response = parseJevResponse(raw)
  assertPinnedServedModel(response.model)

  const expected = Object.keys(questions)
  const actual = Object.keys(response.answers)
  assertSameKeySet(actual, expected, 'answer')

  const answers: Record<string, JevAnswer> = {}
  const distributions: Record<string, JevDistribution> = {}
  for (const questionId of expected) {
    const answer = response.answers[questionId]
    const question = questions[questionId]
    if (answer === undefined || question === undefined) {
      throw new JevInvalidResponseError(
        `Jev returned no answer for question ${JSON.stringify(questionId)}.`,
      )
    }
    assertAnswerMatchesQuestion(answer, question)
    answers[questionId] = answer
    distributions[questionId] = toDistribution(answer)
  }

  return { response, answers, distributions }
}

function assertAnswerMatchesQuestion(answer: JevAnswer, question: JevQuestion): void {
  switch (question.type) {
    case 'noul': {
      if (answer.type !== 'noul') {
        throw answerTypeMismatch(answer.type, question.type)
      }
      return
    }
    case 'choice': {
      if (answer.type !== 'choice') {
        throw answerTypeMismatch(answer.type, question.type)
      }
      const expected = Object.keys(question.criteria)
      assertSameKeySet(
        Object.keys(answer.probabilities),
        expected,
        `${question.type} probabilities`,
      )
      assertDistributionSumsToOne(answer.probabilities, question.type)
      if (!Object.hasOwn(answer.probabilities, answer.choice)) {
        throw new JevInvalidResponseError(
          `Choice answer ${JSON.stringify(answer.choice)} is not present in its probability distribution.`,
        )
      }
      return
    }
    case 'score': {
      if (answer.type !== 'score') {
        throw answerTypeMismatch(answer.type, question.type)
      }
      const expected = question.criteria.map((_, index) => String(index))
      const actual = Object.keys(answer.probabilities)
      assertSameKeySet(actual, expected, `${question.type} probabilities`)
      assertDistributionSumsToOne(answer.probabilities, question.type)
      if (answer.legend !== undefined) {
        assertSameKeySet(Object.keys(answer.legend), actual, `${question.type} legend`)
      }
      return
    }
    default:
      return assertNever(question)
  }
}

function answerTypeMismatch(actual: string, expected: string): JevInvalidResponseError {
  return new JevInvalidResponseError(
    `Jev returned a ${JSON.stringify(actual)} answer for a ${JSON.stringify(expected)} question.`,
  )
}

function assertSameKeySet(
  actual: readonly string[],
  expected: readonly string[],
  context: string,
): void {
  const actualSorted = [...actual].sort()
  const expectedSorted = [...expected].sort()
  const matches =
    actualSorted.length === expectedSorted.length &&
    actualSorted.every((key, index) => key === expectedSorted[index])

  if (!matches) {
    throw new JevInvalidResponseError(`Jev returned an incomplete ${context} distribution.`, {
      details: [
        `expected keys [${expectedSorted.join(', ')}]`,
        `received keys [${actualSorted.join(', ')}]`,
      ],
    })
  }
}

function assertDistributionSumsToOne(
  probabilities: Readonly<Record<string, number>>,
  context: string,
): void {
  const sum = Object.values(probabilities).reduce((total, probability) => total + probability, 0)
  if (Math.abs(sum - 1) > 0.001) {
    throw new JevInvalidResponseError(
      `Jev returned ${context} probabilities that sum to ${sum}, not 1.`,
    )
  }
}

function toDistribution(answer: JevAnswer): JevDistribution {
  switch (answer.type) {
    case 'noul':
      return {
        kind: 'noul',
        probabilityYes: answer.noul,
        probabilityNo: 1 - answer.noul,
      }
    case 'choice':
      return {
        kind: 'choice',
        choice: answer.choice,
        probabilities: { ...answer.probabilities },
        ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
      }
    case 'score':
      return {
        kind: 'score',
        score: answer.score,
        probabilities: { ...answer.probabilities },
        ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
        ...(answer.legend === undefined ? {} : { legend: { ...answer.legend } }),
      }
    default:
      return assertNever(answer)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Jev value: ${JSON.stringify(value)}`)
}
