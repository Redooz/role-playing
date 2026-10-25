import { hashValue } from '@rp/shared'
import { z } from 'zod'
import { langSchema, splitSchema } from '../fixtures/schema.js'

/**
 * Pre-registered run manifest (M0 D3, Architecture Plan v5 §4.1).
 *
 * The manifest is written and validated **before** execution. It is the eval
 * contract in code: fixtures, seeds, scorer, rubric, limits, target metric,
 * guardrails and minimum detectable effect all have to be stated up front. The
 * runner refuses to execute anything without a complete manifest (gate G2), and
 * the manifest hash is recorded with the run so a result can be traced back to
 * the exact registration that produced it.
 *
 * Everything is explicit: there are no schema defaults that could silently fill
 * in a missing field, and unknown keys are rejected (`strictObject`) so a typo
 * in `guardrails` cannot turn a gate into a no-op.
 */

export const MANIFEST_SCHEMA_VERSION = '1.0.0'

/** A metric axis name. Axes are reported individually; there is no composite score. */
export const metricNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_.-]*$/,
    'must start with a lowercase letter and contain only lowercase letters, digits, ".", "_" or "-"',
  )

/** Which way the axis improves. `increase` means a bigger value is better. */
export const metricDirectionSchema = z.enum(['increase', 'decrease'])

export type MetricDirection = z.infer<typeof metricDirectionSchema>

/**
 * The hard invariants the runner evaluates. A manifest registers which ones it
 * requires; unknown ids are a validation error rather than a silent skip.
 */
export const INVARIANT_IDS = [
  'trace.schema_valid',
  'trace.guard_clean',
  'trace.seq_monotonic',
  'trace.content_class',
] as const

export const invariantIdSchema = z.enum(INVARIANT_IDS)

export type InvariantId = z.infer<typeof invariantIdSchema>

export const invariantResultSchema = z.strictObject({
  id: invariantIdSchema,
  ok: z.boolean(),
  detail: z.string().min(1).optional(),
})

export type InvariantResult = z.infer<typeof invariantResultSchema>

const pathSafeIdSchema = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'must start with a letter or digit and contain only letters, digits, ".", "_" or "-"',
  )

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase SHA-256 hex digest')

export const runIdentitySchema = z.strictObject({
  /** Stable run id; also the results directory name. */
  runId: pathSafeIdSchema,
  /** Suite name, e.g. `m0-canned-replay`. */
  suite: pathSafeIdSchema,
  description: z.string().min(1).optional(),
})

export type RunIdentity = z.infer<typeof runIdentitySchema>

export const fixtureSelectionSchema = z
  .strictObject({
    /** Dataset directory under `evals/fixtures/`. */
    dataset: pathSafeIdSchema,
    version: pathSafeIdSchema,
    /** Every requested language must have at least one selected fixture. */
    languages: z.array(langSchema).min(1),
    /** Optional split filter. Omitted means both calibration and holdout. */
    splits: z.array(splitSchema).min(1).optional(),
    /** Optional exact id filter, useful for a focused replay. */
    ids: z.array(z.string().min(1)).min(1).optional(),
  })
  .superRefine((selection, ctx) => {
    if (new Set(selection.languages).size !== selection.languages.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['languages'],
        message: 'languages must not repeat',
      })
    }

    if (
      selection.splits !== undefined &&
      new Set(selection.splits).size !== selection.splits.length
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['splits'],
        message: 'splits must not repeat',
      })
    }

    if (selection.ids !== undefined && new Set(selection.ids).size !== selection.ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['ids'],
        message: 'ids must not repeat',
      })
    }
  })

export type FixtureSelection = z.infer<typeof fixtureSelectionSchema>

export const seedRegistrationSchema = z.strictObject({
  /**
   * Seed for the one documented PRNG in the project (mulberry32, `@rp/shared`).
   * Recorded in every result and version stamp.
   */
  master: z.int().nonnegative(),
  algorithm: z.literal('mulberry32'),
})

export type SeedRegistration = z.infer<typeof seedRegistrationSchema>

export const scorerRegistrationSchema = z.strictObject({
  /** Scorer id, e.g. `deterministic-invariants` or `jev`. */
  id: z.string().min(1),
  /**
   * Semantic scorer version. For Jev this is the pinned model version
   * (`typesafe/jev-1.14` at M0); the runner never substitutes another one.
   */
  version: z.string().min(1),
  /** Model that produced the judgments, when the scorer calls one. */
  judgeModel: z.string().min(1).optional(),
})

export type ScorerRegistration = z.infer<typeof scorerRegistrationSchema>

export const rubricRegistrationSchema = z.strictObject({
  version: z.string().min(1),
  /** Optional ids of the frozen rubric files under `evals/rubrics/`. */
  ids: z.array(z.string().min(1)).min(1).optional(),
})

export type RubricRegistration = z.infer<typeof rubricRegistrationSchema>

export const limitRegistrationSchema = z.strictObject({
  /** Registered repetition count. Never retried beyond it (§4.1.5). */
  repetitions: z.int().positive().max(100),
  /** Registered failure-rate ceiling, in [0, 1]. Exceeding it is inconclusive. */
  maxFailureRate: z.number().finite().min(0).max(1),
})

export type LimitRegistration = z.infer<typeof limitRegistrationSchema>

export const targetRegistrationSchema = z.strictObject({
  metric: metricNameSchema,
  direction: metricDirectionSchema,
  /** Smallest improvement that is treated as signal rather than noise. */
  minimumDetectableEffect: z.number().finite().nonnegative(),
})

export type TargetRegistration = z.infer<typeof targetRegistrationSchema>

export const guardrailRegistrationSchema = z.strictObject({
  metric: metricNameSchema,
  direction: metricDirectionSchema,
  /** Largest tolerated regression. Zero means any regression fails. */
  tolerance: z.number().finite().nonnegative(),
})

export type GuardrailRegistration = z.infer<typeof guardrailRegistrationSchema>

/**
 * Optional pre-registered reference readings. They are copied from an accepted
 * baseline artifact and hashed into this manifest, so the comparison target
 * cannot move after the run starts.
 */
export const baselineReferenceSchema = z
  .strictObject({
    runId: pathSafeIdSchema,
    manifestHash: sha256Schema.optional(),
    metrics: z.record(metricNameSchema, z.number().finite()),
  })
  .superRefine((baseline, ctx) => {
    if (Object.keys(baseline.metrics).length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['metrics'],
        message: 'baseline metrics must name at least one axis',
      })
    }
  })

export type BaselineReference = z.infer<typeof baselineReferenceSchema>

export const providerRegistrationSchema = z
  .strictObject({
    /** Canned replay is the only provider wired at M0. */
    mode: z.enum(['canned', 'live']),
    /** Human-readable label written into traces/results; never a secret. */
    label: z.string().min(1),
    /** Explicit opt-in required before a live provider may run. */
    allowLive: z.boolean(),
  })
  .superRefine((provider, ctx) => {
    if (provider.mode === 'live' && !provider.allowLive) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowLive'],
        message: 'live provider requires allowLive: true (explicit manifest opt-in)',
      })
    }
  })

export type ProviderRegistration = z.infer<typeof providerRegistrationSchema>

export const runManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
    run: runIdentitySchema,
    fixtures: fixtureSelectionSchema,
    seeds: seedRegistrationSchema,
    scorer: scorerRegistrationSchema,
    rubric: rubricRegistrationSchema,
    limits: limitRegistrationSchema,
    target: targetRegistrationSchema,
    guardrails: z.array(guardrailRegistrationSchema).min(1),
    invariants: z.array(invariantIdSchema).min(1),
    provider: providerRegistrationSchema,
    baseline: baselineReferenceSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    const guardrailMetrics = manifest.guardrails.map((guardrail) => guardrail.metric)
    if (new Set(guardrailMetrics).size !== guardrailMetrics.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['guardrails'],
        message: 'guardrail metrics must be unique; each axis is reported once',
      })
    }

    if (guardrailMetrics.includes(manifest.target.metric)) {
      ctx.addIssue({
        code: 'custom',
        path: ['target', 'metric'],
        message: `target metric "${manifest.target.metric}" is also registered as a guardrail`,
      })
    }

    if (new Set(manifest.invariants).size !== manifest.invariants.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['invariants'],
        message: 'invariants must not repeat',
      })
    }
  })

export type RunManifest = z.infer<typeof runManifestSchema>

/** One explicit, field-named manifest problem (gate G2). */
export interface ManifestIssue {
  /** Dotted field path, or `<root>`. */
  readonly path: string
  /** Human-readable explanation that names the field. */
  readonly message: string
}

export class ManifestValidationError extends Error {
  readonly issues: readonly ManifestIssue[]

  constructor(issues: readonly ManifestIssue[]) {
    super(`invalid run manifest: ${issues.map((issue) => issue.message).join('; ')}`)
    this.name = 'ManifestValidationError'
    this.issues = issues
  }
}

interface RawIssue {
  readonly code?: string
  readonly path?: readonly PropertyKey[]
  readonly message: string
  readonly keys?: readonly string[]
}

/** Stable manifest hash: canonical JSON → SHA-256. */
export function manifestHash(manifest: RunManifest): string {
  return hashValue(manifest)
}

/** Parse a manifest, throwing {@link ManifestValidationError} with every issue. */
export function parseManifest(input: unknown): RunManifest {
  const parsed = runManifestSchema.safeParse(input)
  if (!parsed.success) throw new ManifestValidationError(toManifestIssues(parsed.error.issues))
  return parsed.data
}

export type ManifestValidationResult =
  | { readonly ok: true; readonly manifest: RunManifest; readonly manifestHash: string }
  | { readonly ok: false; readonly issues: readonly ManifestIssue[] }

/** Non-throwing validation used by the CLI so it can print every problem at once. */
export function validateManifest(input: unknown): ManifestValidationResult {
  const parsed = runManifestSchema.safeParse(input)
  if (!parsed.success) return { ok: false, issues: toManifestIssues(parsed.error.issues) }
  return { ok: true, manifest: parsed.data, manifestHash: manifestHash(parsed.data) }
}

/** Format one issue for stderr, one line per problem. */
export function formatManifestIssue(issue: ManifestIssue): string {
  return issue.message
}

function toManifestIssues(issues: readonly RawIssue[]): ManifestIssue[] {
  return issues.map((issue) => {
    const path = renderPath(issue.path ?? [])
    const detail = describeIssue(issue)
    return {
      path: path === '' ? '<root>' : path,
      message: path === '' ? detail : `${path}: ${detail}`,
    }
  })
}

function describeIssue(issue: RawIssue): string {
  if (isMissingField(issue)) return 'missing required field'
  if (issue.code === 'unrecognized_keys' && issue.keys !== undefined && issue.keys.length > 0) {
    return `unrecognized field(s): ${issue.keys.join(', ')}`
  }
  return issue.message
}

function isMissingField(issue: RawIssue): boolean {
  const path = issue.path ?? []
  return path.length > 0 && /received undefined/i.test(issue.message)
}

function renderPath(path: readonly PropertyKey[]): string {
  let rendered = ''
  for (const segment of path) {
    if (typeof segment === 'number') {
      rendered += `[${segment}]`
    } else if (rendered === '') {
      rendered = String(segment)
    } else {
      rendered += `.${String(segment)}`
    }
  }
  return rendered
}
