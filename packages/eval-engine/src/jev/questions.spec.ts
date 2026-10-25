import { describe, expect, it } from 'vitest'
import { JEV_MODEL, JEV_SMOKE_RUBRIC_VERSION, NO_EXTRACTION_VERSION } from './constants.js'
import { JevConfigError } from './errors.js'
import {
  buildEnglishSmokeJudgment,
  buildFrenchSmokeJudgment,
  buildUnsettledSmokeJudgment,
  declareJevJudgment,
  declareJevQuestionMetadata,
  SMOKE_EN_QUESTION_ID,
  SMOKE_FR_QUESTION_ID,
  SMOKE_UNSETTLED_QUESTION_ID,
} from './questions.js'
import type { JevJudgment } from './types.js'

describe('declareJevQuestionMetadata', () => {
  it('defaults the scorer to the pin and extraction to none', () => {
    const metadata = declareJevQuestionMetadata({
      id: '  q1  ',
      lang: 'en',
      rubricVersion: 'rubric-v1',
    })

    expect(metadata).toEqual({
      id: 'q1',
      lang: 'en',
      rubricVersion: 'rubric-v1',
      scorerVersion: JEV_MODEL,
      extractionVersion: NO_EXTRACTION_VERSION,
    })
  })

  it('rejects another scorer version', () => {
    expect(() =>
      declareJevQuestionMetadata({
        id: 'q1',
        lang: 'en',
        rubricVersion: 'rubric-v1',
        scorerVersion: 'typesafe/jev-1.13',
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
      expect(judgment.metadata.scorerVersion).toBe(JEV_MODEL)
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
})
