import { describe, expect, it } from 'vitest'
import { JEV_MODEL, JEV_SMOKE_RUBRIC_VERSION, NO_EXTRACTION_VERSION } from './constants.js'
import { JevConfigError } from './errors.js'
import {
  buildEnglishSmokeJudgment,
  buildFrenchSmokeJudgment,
  buildUnsettledSmokeJudgment,
  declareJevBatchJudgment,
  declareJevJudgment,
  declareJevQuestionMetadata,
  SMOKE_EN_QUESTION_ID,
  SMOKE_FR_QUESTION_ID,
  SMOKE_UNSETTLED_QUESTION_ID,
} from './questions.js'
import type { JevJudgment } from './types.js'

function configError(run: () => unknown): JevConfigError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(JevConfigError)
    return error as JevConfigError
  }
  throw new Error('expected a JevConfigError')
}

describe('declareJevQuestionMetadata', () => {
  it('defaults the grader to the pin and extraction to none', () => {
    const metadata = declareJevQuestionMetadata({
      id: '  q1  ',
      lang: 'en',
      rubricVersion: 'rubric-v1',
    })

    expect(metadata).toEqual({
      id: 'q1',
      lang: 'en',
      rubricVersion: 'rubric-v1',
      graderVersion: JEV_MODEL,
      extractionVersion: NO_EXTRACTION_VERSION,
    })
  })

  it('rejects another grader version', () => {
    expect(() =>
      declareJevQuestionMetadata({
        id: 'q1',
        lang: 'en',
        rubricVersion: 'rubric-v1',
        graderVersion: 'typesafe/jev-1.13',
      }),
    ).toThrow(JevConfigError)
  })

  it('rejects an empty id or rubric version', () => {
    expect(() =>
      declareJevQuestionMetadata({ id: '   ', lang: 'en', rubricVersion: 'rubric-v1' }),
    ).toThrow(JevConfigError)
    expect(() => declareJevQuestionMetadata({ id: 'q1', lang: 'en', rubricVersion: '' })).toThrow(
      JevConfigError,
    )
  })

  it('carries a canonical locale only when one is supplied', () => {
    const withLocale = declareJevQuestionMetadata({
      id: 'q1',
      lang: 'en',
      locale: 'en-GB',
      rubricVersion: 'rubric-v1',
    })
    expect(withLocale).toStrictEqual({
      id: 'q1',
      lang: 'en',
      locale: 'en-GB',
      rubricVersion: 'rubric-v1',
      graderVersion: JEV_MODEL,
      extractionVersion: NO_EXTRACTION_VERSION,
    })

    const withoutLocale = declareJevQuestionMetadata({
      id: 'q1',
      lang: 'en',
      rubricVersion: 'rubric-v1',
    })
    expect('locale' in withoutLocale).toBe(false)
  })

  it('reports metadata issues with the exact message and details', () => {
    const error = configError(() =>
      declareJevQuestionMetadata({ id: '   ', lang: 'en', rubricVersion: 'rubric-v1' }),
    )
    expect(error.message).toBe('Invalid Jev question metadata.')
    expect(error.details).toHaveLength(1)
    expect(error.details[0]).toMatch(/^id: /u)
  })
})

describe('declareJevJudgment', () => {
  it('returns one validated judgment', () => {
    const judgment = declareJevJudgment({
      metadata: { id: 'q1', lang: 'en', rubricVersion: 'rubric-v1' },
      state: { utterance: 'Please send the report.' },
      question: {
        type: 'noul',
        instructions: 'Is this a request?',
        criteria: {
          true: 'The utterance asks for something.',
          false: 'The utterance does not ask for anything.',
        },
      },
    })

    expect(judgment.metadata.id).toBe('q1')
    expect(judgment.question.type).toBe('noul')
  })

  it('rejects a choice question with fewer than two criteria', () => {
    expect(() =>
      declareJevJudgment({
        metadata: { id: 'q1', lang: 'en', rubricVersion: 'rubric-v1' },
        state: 'hello',
        question: {
          type: 'choice',
          instructions: 'Pick one.',
          criteria: { only: 'The only option.' },
        },
      }),
    ).toThrow(JevConfigError)
  })

  it('rejects a score question with fewer than two levels', () => {
    expect(() =>
      declareJevJudgment({
        metadata: { id: 'q1', lang: 'en', rubricVersion: 'rubric-v1' },
        state: 'hello',
        question: {
          type: 'score',
          instructions: 'Rate it.',
          criteria: ['Only one level'],
        },
      }),
    ).toThrow(JevConfigError)
  })

  it('reports judgment issues with the exact message and details', () => {
    const error = configError(() =>
      declareJevJudgment({
        metadata: { id: 'q1', lang: 'en', rubricVersion: 'rubric-v1' },
        state: 'hello',
        question: {
          type: 'choice',
          instructions: 'Pick one.',
          criteria: { only: 'The only option.' },
        },
      }),
    )
    expect(error.message).toBe('Invalid Jev judgment.')
    expect(error.details).toEqual([
      'question.criteria: A choice question needs at least two criteria.',
    ])
  })
})

describe('declareJevBatchJudgment', () => {
  const validInput = {
    metadata: { id: 'batch-1', lang: 'en' as const, rubricVersion: 'rubric-v1' },
    state: { utterance: 'Hello.' },
    questions: {
      first: {
        type: 'noul' as const,
        instructions: 'Is it a greeting?',
        criteria: { true: 'It greets someone.', false: 'It does not greet anyone.' },
      },
      second: {
        type: 'choice' as const,
        instructions: 'Who speaks?',
        criteria: { manager: 'The manager.', peer: 'The peer.' },
      },
    },
  }

  it('validates and returns a batched judgment', () => {
    const judgment = declareJevBatchJudgment(validInput)
    expect(judgment.metadata).toStrictEqual({
      id: 'batch-1',
      lang: 'en',
      rubricVersion: 'rubric-v1',
      graderVersion: JEV_MODEL,
      extractionVersion: NO_EXTRACTION_VERSION,
    })
    expect(judgment.state).toStrictEqual({ utterance: 'Hello.' })
    expect(judgment.questions).toStrictEqual(validInput.questions)
  })

  it('rejects a batch with fewer than two questions', () => {
    const error = configError(() =>
      declareJevBatchJudgment({
        ...validInput,
        questions: { first: validInput.questions.first },
      }),
    )
    expect(error.message).toBe('Invalid batched Jev judgment.')
    expect(error.details).toEqual(['questions: A batched judgment needs at least two questions.'])
  })
})

describe('pre-registered smoke questions', () => {
  const judgments: readonly JevJudgment[] = [
    buildEnglishSmokeJudgment(),
    buildFrenchSmokeJudgment(),
    buildUnsettledSmokeJudgment(),
  ]

  it('provides three uniquely identified questions with pinned metadata', () => {
    expect(judgments).toHaveLength(3)
    expect(judgments.map((judgment) => judgment.metadata.lang)).toEqual(['en', 'fr', 'en'])
    expect(new Set(judgments.map((judgment) => judgment.metadata.id)).size).toBe(3)
    expect(judgments.map((judgment) => judgment.metadata.id)).toEqual([
      SMOKE_EN_QUESTION_ID,
      SMOKE_FR_QUESTION_ID,
      SMOKE_UNSETTLED_QUESTION_ID,
    ])

    for (const judgment of judgments) {
      expect(judgment.metadata.graderVersion).toBe(JEV_MODEL)
      expect(judgment.metadata.rubricVersion).toBe(JEV_SMOKE_RUBRIC_VERSION)
      expect(judgment.metadata.extractionVersion).toBe(NO_EXTRACTION_VERSION)
      expect(judgment.question.type).toBe('noul')
    }
  })

  it('uses French state and criteria for the French question', () => {
    const judgment = buildFrenchSmokeJudgment()
    expect(JSON.stringify(judgment)).toMatch(/présentation/)
    if (judgment.question.type !== 'noul') throw new Error('expected a noul question')
    expect(judgment.question.instructions).toMatch(/avis/)
    expect(judgment.question.criteria.true).toMatch(/avis/)
  })

  it('keeps the unsettled criteria symmetric and non-empty', () => {
    const judgment = buildUnsettledSmokeJudgment()
    if (judgment.question.type !== 'noul') throw new Error('expected a noul question')

    expect(judgment.question.criteria.true.length).toBeGreaterThan(0)
    expect(judgment.question.criteria.false.length).toBeGreaterThan(0)
    expect(judgment.question.criteria.true).not.toBe(judgment.question.criteria.false)
  })

  it('pins the exact English smoke question', () => {
    expect(buildEnglishSmokeJudgment()).toStrictEqual({
      metadata: {
        id: SMOKE_EN_QUESTION_ID,
        lang: 'en',
        rubricVersion: JEV_SMOKE_RUBRIC_VERSION,
        graderVersion: JEV_MODEL,
        extractionVersion: NO_EXTRACTION_VERSION,
      },
      state: {
        context: 'A client is waiting for an update on a proposal.',
        utterance: 'Hi, could you let me know where the proposal stands?',
      },
      question: {
        type: 'noul',
        instructions: 'Does the utterance directly ask for a status update on the proposal?',
        criteria: {
          true: 'The speaker asks to be told the current status of the proposal.',
          false: 'The speaker does not ask for the current status of the proposal.',
        },
      },
    })
  })

  it('pins the exact French smoke question', () => {
    expect(buildFrenchSmokeJudgment()).toStrictEqual({
      metadata: {
        id: SMOKE_FR_QUESTION_ID,
        lang: 'fr',
        rubricVersion: JEV_SMOKE_RUBRIC_VERSION,
        graderVersion: JEV_MODEL,
        extractionVersion: NO_EXTRACTION_VERSION,
      },
      state: {
        context: 'Une collègue demande un avis sur une présentation avant une réunion.',
        utterance: 'Est-ce que tu pourrais me dire ce que tu penses de la présentation ?',
      },
      question: {
        type: 'noul',
        instructions: "L'énoncé demande-t-il directement un avis sur la présentation ?",
        criteria: {
          true: "La personne demande explicitement l'avis de son interlocuteur sur la présentation.",
          false: "La personne ne demande pas l'avis de son interlocuteur sur la présentation.",
        },
      },
    })
  })

  it('pins the exact unsettled smoke question', () => {
    expect(buildUnsettledSmokeJudgment()).toStrictEqual({
      metadata: {
        id: SMOKE_UNSETTLED_QUESTION_ID,
        lang: 'en',
        rubricVersion: JEV_SMOKE_RUBRIC_VERSION,
        graderVersion: JEV_MODEL,
        extractionVersion: NO_EXTRACTION_VERSION,
      },
      state: {
        context: 'A release decision note discussed by the team.',
        utterance:
          'We should ship on Friday: the build is stable, but the documentation is not finished.',
      },
      question: {
        type: 'noul',
        instructions: 'Does the note support shipping on Friday?',
        criteria: {
          true: 'The note gives a reason to ship on Friday, namely that the build is stable.',
          false:
            'The note gives a reason not to ship on Friday, namely that the documentation is unfinished.',
        },
      },
    })
  })
})
