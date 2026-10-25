import { z } from 'zod'
import { JEV_MODEL } from './constants.js'

const nonEmptyText = z.string().min(1)

const probabilitySchema = z.number().finite().min(0).max(1)

export const jevNoulQuestionSchema = z.object({
  type: z.literal('noul'),
  instructions: nonEmptyText,
  criteria: z.object({
    true: nonEmptyText,
    false: nonEmptyText,
  }),
})

export const jevChoiceQuestionSchema = z.object({
  type: z.literal('choice'),
  instructions: nonEmptyText,
  criteria: z.record(z.string(), nonEmptyText),
})

export const jevScoreQuestionSchema = z.object({
  type: z.literal('score'),
  instructions: nonEmptyText,
  criteria: z.array(nonEmptyText).min(2),
})

export const jevQuestionSchema = z.discriminatedUnion('type', [
  jevNoulQuestionSchema,
  jevChoiceQuestionSchema,
  jevScoreQuestionSchema,
])

export const jevQuestionMetadataSchema = z.object({
  id: z.string().trim().min(1),
  lang: z.enum(['en', 'fr']),
  rubricVersion: nonEmptyText,
  // A different scorer is a different model, and this package may only call the pin.
  scorerVersion: z.literal(JEV_MODEL),
  extractionVersion: nonEmptyText,
})

export const jevStateSchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
])

export const jevJudgmentSchema = z
  .object({
    metadata: jevQuestionMetadataSchema,
    state: jevStateSchema,
    question: jevQuestionSchema,
  })
  .superRefine((judgment, ctx) => {
    const question = judgment.question
    if (question.type === 'choice') {
      const labels = Object.keys(question.criteria)
      if (labels.length < 2) {
        ctx.addIssue({
          code: 'custom',
          path: ['question', 'criteria'],
          message: 'A choice question needs at least two criteria.',
        })
      }
      if (labels.some((label) => label.trim() === '')) {
        ctx.addIssue({
          code: 'custom',
          path: ['question', 'criteria'],
          message: 'Choice criteria labels must be non-empty.',
        })
      }
    }
  })

export const jevNoulAnswerSchema = z.object({
  type: z.literal('noul'),
  noul: probabilitySchema,
})

export const jevChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: nonEmptyText,
  probabilities: z.record(z.string(), probabilitySchema),
  confidence: probabilitySchema.optional(),
})

export const jevScoreAnswerSchema = z.object({
  type: z.literal('score'),
  score: z.number().finite(),
  probabilities: z.record(z.string(), probabilitySchema),
  confidence: probabilitySchema.optional(),
  legend: z.record(z.string(), nonEmptyText).optional(),
})

export const jevAnswerSchema = z.discriminatedUnion('type', [
  jevNoulAnswerSchema,
  jevChoiceAnswerSchema,
  jevScoreAnswerSchema,
])

export const jevResponseSchema = z.object({
  model: nonEmptyText,
  answers: z.record(z.string(), jevAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost: z.number().finite().nonnegative().optional(),
  }),
  id: nonEmptyText.optional(),
  provider: nonEmptyText.optional(),
})

/** Stable, readable Zod issue summaries for typed error details. */
export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'
    return `${path}: ${issue.message}`
  })
}
