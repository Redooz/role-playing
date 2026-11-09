import { JEV_GRADER_VERSION, JEV_SMOKE_RUBRIC_VERSION, NO_EXTRACTION_VERSION } from './constants.js'
import { JevConfigError } from './errors.js'
import { formatZodIssues, jevJudgmentSchema, jevQuestionMetadataSchema } from './schemas.js'
import type { JevJudgment, JevLang, JevQuestion, JevQuestionMetadata, JevState } from './types.js'

export interface JevQuestionMetadataInput {
  readonly id: string
  readonly lang: JevLang
  /** Canonical BCP 47 locale, when a locale variant is being judged. */
  readonly locale?: string
  readonly rubricVersion: string
  /** Defaults to the pinned grader; a different value is rejected. */
  readonly graderVersion?: string
  /** Defaults to `none`, meaning the judgment consumes raw text without an extractor. */
  readonly extractionVersion?: string
}

/**
 * Declare the version stamps for one question.
 *
 * `graderVersion` is not freely configurable: the schema only accepts the
 * pinned model, so a caller cannot silently score with a different version.
 */
export function declareJevQuestionMetadata(input: JevQuestionMetadataInput): JevQuestionMetadata {
  const parsed = jevQuestionMetadataSchema.safeParse({
    id: input.id,
    lang: input.lang,
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    rubricVersion: input.rubricVersion,
    graderVersion: input.graderVersion ?? JEV_GRADER_VERSION,
    extractionVersion: input.extractionVersion ?? NO_EXTRACTION_VERSION,
  })

  if (!parsed.success) {
    throw new JevConfigError('Invalid Jev question metadata.', {
      details: formatZodIssues(parsed.error),
    })
  }

  return parsed.data
}

export interface JevJudgmentInput {
  readonly metadata: JevQuestionMetadataInput
  readonly state: JevState
  readonly question: JevQuestion
}

/** Build one atomic judgment and validate its question shape before it can be sent. */
export function declareJevJudgment(input: JevJudgmentInput): JevJudgment {
  const metadata = declareJevQuestionMetadata(input.metadata)

  const parsed = jevJudgmentSchema.safeParse({
    metadata,
    state: input.state,
    question: input.question,
  })

  if (!parsed.success) {
    throw new JevConfigError('Invalid Jev judgment.', {
      details: formatZodIssues(parsed.error),
    })
  }

  return parsed.data
}

export const SMOKE_EN_QUESTION_ID = 'smoke-en-status-request'
export const SMOKE_FR_QUESTION_ID = 'smoke-fr-feedback-request'
export const SMOKE_UNSETTLED_QUESTION_ID = 'smoke-unsettled-ship-decision'

/**
 * Pre-registered English smoke question (gate G4).
 *
 * A concrete status request is easy for any working grader, so a failure here
 * points at the integration (auth, pin, response shape), not the rubric.
 */
export function buildEnglishSmokeJudgment(): JevJudgment {
  return declareJevJudgment({
    metadata: {
      id: SMOKE_EN_QUESTION_ID,
      lang: 'en',
      rubricVersion: JEV_SMOKE_RUBRIC_VERSION,
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
}

/**
 * Pre-registered French smoke question (gate G4).
 *
 * Passing in English does not qualify French, so the instructions and criteria
 * are written in French and scored against French state.
 */
export function buildFrenchSmokeJudgment(): JevJudgment {
  return declareJevJudgment({
    metadata: {
      id: SMOKE_FR_QUESTION_ID,
      lang: 'fr',
      rubricVersion: JEV_SMOKE_RUBRIC_VERSION,
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
}

/**
 * Pre-registered unsettled question (gate G4).
 *
 * The state deliberately contains one reason for and one reason against, and
 * the two criteria are symmetric. Neither side is correct, so the canary only
 * requires the model to return a two-sided probability strictly inside (0, 1).
 */
export function buildUnsettledSmokeJudgment(): JevJudgment {
  return declareJevJudgment({
    metadata: {
      id: SMOKE_UNSETTLED_QUESTION_ID,
      lang: 'en',
      rubricVersion: JEV_SMOKE_RUBRIC_VERSION,
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
}

/** The three builders in suite order: English, French, unsettled. */
export const SMOKE_JUDGMENT_BUILDERS = [
  buildEnglishSmokeJudgment,
  buildFrenchSmokeJudgment,
  buildUnsettledSmokeJudgment,
] as const
