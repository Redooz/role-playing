import { z } from 'zod'

/**
 * Zod schemas for the English/French eval task workflow (M0 D5).
 *
 * Zod is the source of truth. The JSON Schemas committed under `evals/schemas/`
 * are generated from these definitions with `z.toJSONSchema`; a unit test fails
 * when the committed files drift. Types are inferred with `z.infer`, so nothing
 * in this module needs a hand-written interface.
 *
 * Layout contract (see `validate.ts` for the walker that enforces it):
 *
 * ```text
 * evals/tasks/<dataset>/<version>/<lang>/.../*.json   -> taskEntrySchema
 * evals/golden/<lang>/<version>/.../*.json               -> goldenEntrySchema
 * ```
 */

/** Languages with a calibration workflow. Adding one here is not enough: §4.4.10 requires a golden set too. */
export const LANGS = ['en', 'fr'] as const
/** CEFR bands used for stratification (§4.4.2). */
export const CEFR_BANDS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const
/** Calibration data may guide changes; holdouts stay frozen (§4.6.6). */
export const SPLITS = ['calibration', 'holdout'] as const

export const langSchema = z.enum(LANGS)
export const cefrBandSchema = z.enum(CEFR_BANDS)
export const splitSchema = z.enum(SPLITS)

export type Lang = z.infer<typeof langSchema>
export type CefrBand = z.infer<typeof cefrBandSchema>
export type Split = z.infer<typeof splitSchema>

/**
 * Where an entry came from (§4.6.9).
 *
 * M0 ships synthetic data only (resolved decision O4). `recorded` entries may
 * only appear after the consented collection workflow exists; `consentScope` on
 * the entry records the permission that covers storage, annotation, and eval use.
 */
export const provenanceSchema = z
  .strictObject({
    source: z.enum(['synthetic', 'recorded']),
    note: z.string().min(1).optional(),
    collectedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .superRefine((provenance, ctx) => {
    if (provenance.source === 'recorded' && provenance.collectedAt === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['collectedAt'],
        message:
          'recorded provenance must state collectedAt so retention and deletion can be scoped',
      })
    }
  })

export type Provenance = z.infer<typeof provenanceSchema>

/**
 * Ordered transcript turns. `role: 'user'` is the learner, `role: 'persona'` is
 * one of the AI characters. Audio references arrive in a later milestone; M0 is
 * text-only.
 */
export const turnSchema = z.strictObject({
  role: z.enum(['user', 'persona']),
  text: z.string().min(1),
})

export const taskContentSchema = z.strictObject({
  scenarioBrief: z.string().min(1).optional(),
  turns: z.array(turnSchema).min(1),
})

/** A name → version map, e.g. `{ rubric: 'v1', annotationGuideline: 'v1' }`. */
const annotationVersionsSchema = z
  .record(z.string().min(1), z.string().min(1))
  .refine((versions) => Object.keys(versions).length > 0, {
    message: 'annotationVersions must name at least one annotation artifact',
  })

export const taskEntrySchema = z.strictObject({
  /** Stable within one dataset version + language. */
  id: z.string().min(1),
  lang: langSchema,
  domain: z.string().min(1),
  scenarioType: z.string().min(1),
  cefrBand: cefrBandSchema,
  /**
   * Who produced the learner side of the transcript. Calibration/holdout splits
   * are disjoint by this id, never by utterance (§4.6.5).
   */
  speakerId: z.string().min(1),
  split: splitSchema,
  provenance: provenanceSchema,
  /** Non-empty permission scope. Synthetic data uses `synthetic-no-consent-required`. */
  consentScope: z.string().min(1),
  annotationVersions: annotationVersionsSchema,
  content: taskContentSchema,
})

export type TaskEntry = z.infer<typeof taskEntrySchema>

/**
 * Agreement block required before a golden entry may be `stable` (§4.4.4).
 *
 * `metric` names the statistic (for example `cohen_kappa`, `icc_2_1`, or
 * `percent_agreement`); `value` is its measured value. The rubric that defines
 * the required threshold is pre-registered per language (§4.4.6), not here.
 */
export const annotatorAgreementSchema = z.strictObject({
  /** At least two distinct annotators are needed for agreement to mean anything. */
  annotators: z.array(z.string().min(1)).min(1),
  metric: z.string().min(1),
  value: z.number().finite().min(-1).max(1),
  measuredAt: z.iso.datetime({ offset: true }).optional(),
  notes: z.string().min(1).optional(),
})

export type AnnotatorAgreement = z.infer<typeof annotatorAgreementSchema>

/**
 * True when agreement was measured by at least two distinct annotators and a
 * metric/value pair is stated. Agreement statistics live in [-1, 1].
 */
export function hasMeasuredAgreement(value: unknown): boolean {
  const parsed = annotatorAgreementSchema.safeParse(value)
  if (!parsed.success) return false
  return new Set(parsed.data.annotators).size >= 2 && parsed.data.metric.length > 0
}

/** One human judgment about a single transcript. */
export const goldenEntrySchema = z
  .strictObject({
    /** Stable within one language + version. */
    id: z.string().min(1),
    lang: langSchema,
    split: splitSchema,
    /**
     * Link to a task in the same language and version. When present it must
     * resolve, and the golden entry's split must match the task's split.
     */
    taskId: z.string().min(1).optional(),
    /**
     * Which character the turn should be routed to (§4.4.3). `intent` is a short
     * human label; the persona ids are tournament arms, not model versions.
     */
    routingLabels: z.strictObject({
      intent: z.string().min(1),
      expectedPersonaId: z.string().min(1),
      acceptablePersonaIds: z.array(z.string().min(1)).optional(),
      note: z.string().min(1).optional(),
    }),
    /**
     * 1–5 rubric scores keyed by dimension name. Keeping dimension names as data
     * lets a rubric version add a dimension without a schema major bump.
     */
    dimensionScores: z
      .record(
        z.string().min(1),
        z.strictObject({
          score: z.number().int().min(1).max(5),
          rationale: z.string().min(1).optional(),
        }),
      )
      .refine((scores) => Object.keys(scores).length > 0, {
        message: 'dimensionScores must contain at least one dimension',
      }),
    /** Spans that justify a score or label, by turn index and text reference. */
    evidenceSpans: z.array(
      z.strictObject({
        turnIndex: z.number().int().min(0),
        /** Quote (or stable fragment) from the referenced turn. */
        textRef: z.string().min(1),
        dimension: z.string().min(1).optional(),
        note: z.string().min(1).optional(),
      }),
    ),
    /** Blind pairwise comparisons, with presentation order recorded (§4.4.7). */
    pairwisePreferences: z.array(
      z.strictObject({
        opponentId: z.string().min(1),
        preference: z.enum(['self', 'opponent', 'tie']),
        presentationOrder: z.enum(['self-first', 'opponent-first']),
        blinded: z.boolean(),
        note: z.string().min(1).optional(),
      }),
    ),
    /** Optional until measured. A `stable` entry must carry a valid block. */
    annotatorAgreement: annotatorAgreementSchema.optional(),
    /**
     * `draft` entries are usable for tooling checks but are not ground truth.
     * `stable` is reserved for entries whose labels passed the agreement gate.
     */
    status: z.enum(['draft', 'stable', 'retired']),
    notes: z.string().min(1).optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.status !== 'stable') return
    if (!hasMeasuredAgreement(entry.annotatorAgreement)) {
      ctx.addIssue({
        code: 'custom',
        path: ['annotatorAgreement'],
        message:
          "status 'stable' requires a measured annotatorAgreement block with at least 2 distinct annotators, a metric, and a value",
      })
    }
  })

export type GoldenEntry = z.infer<typeof goldenEntrySchema>
