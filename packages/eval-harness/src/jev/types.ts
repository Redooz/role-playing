import type { JevError } from './errors.js'

/** Languages enabled for grading. Other languages are disabled until calibrated. */
export type JevLang = 'en' | 'fr'

/** Input evaluated by Jev: a string, or a JSON object/array of related context. */
export type JevState = string | Record<string, unknown> | readonly unknown[]

export interface JevNoulCriteria {
  readonly true: string
  readonly false: string
}

/** A boolean judgment. The API calls this question type `noul`. */
export interface JevNoulQuestion {
  readonly type: 'noul'
  readonly instructions: string
  readonly criteria: JevNoulCriteria
}

/** An exclusive-choice judgment with one readable criterion per option. */
export interface JevChoiceQuestion {
  readonly type: 'choice'
  readonly instructions: string
  readonly criteria: Readonly<Record<string, string>>
}

/** An ordered-scale judgment. Index 0 is the first criterion. */
export interface JevScoreQuestion {
  readonly type: 'score'
  readonly instructions: string
  readonly criteria: readonly string[]
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion

/** Version stamps that travel with every question and enter the cache key. */
export interface JevQuestionMetadata {
  readonly id: string
  readonly lang: JevLang
  /** Canonical BCP 47 locale; it enters the cache key so variants never share a score. */
  readonly locale?: string
  readonly rubricVersion: string
  readonly graderVersion: string
  readonly extractionVersion: string
}

/**
 * One atomic observable judgment: one state, one question, one metadata block.
 *
 * The client always sends exactly one question per API call; broad questions
 * such as "should this persona speak?" must be split by the caller.
 */
export interface JevJudgment {
  readonly metadata: JevQuestionMetadata
  readonly state: JevState
  readonly question: JevQuestion
}

/** Several independent questions that share one state and one API call. */
export type JevQuestionSet = Readonly<Record<string, JevQuestion>>

export interface JevBatchJudgment {
  readonly metadata: JevQuestionMetadata
  readonly state: JevState
  readonly questions: JevQuestionSet
}

export interface JevRequestPayload {
  readonly model: string
  readonly state: JevState
  readonly questions: Readonly<Record<string, JevQuestion>>
}

export interface JevUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cost?: number
}

export interface JevNoulAnswer {
  readonly type: 'noul'
  readonly noul: number
}

export interface JevChoiceAnswer {
  readonly type: 'choice'
  readonly choice: string
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence?: number
}

export interface JevScoreAnswer {
  readonly type: 'score'
  readonly score: number
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence?: number
  readonly legend?: Readonly<Record<string, string>>
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer

/** The validated Decisions response. `raw` on a result keeps fields this type drops. */
export interface JevResponse {
  readonly model: string
  readonly answers: Readonly<Record<string, JevAnswer>>
  readonly usage: JevUsage
  readonly id?: string
  readonly provider?: string
}

/**
 * Normalized probability distribution.
 *
 * A `noul` answer exposes both sides so a caller can never mistake a low
 * probability for a "no" label. Choice and score answers expose the full map,
 * not just the argmax.
 */
export interface JevNoulDistribution {
  readonly kind: 'noul'
  readonly probabilityYes: number
  readonly probabilityNo: number
}

export interface JevChoiceDistribution {
  readonly kind: 'choice'
  readonly choice: string
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence?: number
}

export interface JevScoreDistribution {
  readonly kind: 'score'
  readonly score: number
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence?: number
  readonly legend?: Readonly<Record<string, string>>
}

export type JevDistribution = JevNoulDistribution | JevChoiceDistribution | JevScoreDistribution

export interface JevCacheStatus {
  /** `null` only when configuration failed before a key could be computed. */
  readonly key: string | null
  readonly hit: boolean
  readonly stored: boolean
}

export interface JevJudgmentSuccess {
  readonly ok: true
  readonly questionId: string
  /** The exact payload sent (or that would have been sent on a cache hit). */
  readonly request: JevRequestPayload
  /** Validated response with unknown fields stripped. */
  readonly response: JevResponse
  /** Full JSON body exactly as received, including fields not modeled here. */
  readonly raw: unknown
  readonly distribution: JevDistribution
  readonly usage: JevUsage
  /** Dated snapshot that actually served the request, e.g. `typesafe/jev-1.14-20261014`. */
  readonly servedModel: string
  readonly cache: JevCacheStatus
}

export interface JevJudgmentFailure {
  readonly ok: false
  readonly questionId: string
  readonly error: JevError
  readonly cache: JevCacheStatus
  // Deliberately no distribution, label, score, or zero: a failure cannot be
  // mistaken for a negative judgment.
}

export type JevResult = JevJudgmentSuccess | JevJudgmentFailure

export interface JevBatchSuccess {
  readonly ok: true
  readonly questionIds: readonly string[]
  readonly request: JevRequestPayload
  readonly response: JevResponse
  readonly raw: unknown
  readonly answers: Readonly<Record<string, JevAnswer>>
  readonly distributions: Readonly<Record<string, JevDistribution>>
  readonly usage: JevUsage
  readonly servedModel: string
  readonly cache: JevCacheStatus
}

export interface JevBatchFailure {
  readonly ok: false
  readonly questionIds: readonly string[]
  readonly error: JevError
  readonly cache: JevCacheStatus
}

export type JevBatchResult = JevBatchSuccess | JevBatchFailure

/** The narrow port the smoke suite needs; a real client or a fake can satisfy it. */
export interface JevGrader {
  grade(judgment: JevJudgment): Promise<JevResult>
}
