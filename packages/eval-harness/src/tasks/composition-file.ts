import { z } from 'zod'
import { renderFieldPath } from './violations.js'

/**
 * The composition file contract (M3c P2): schema, reserved path and parser.
 *
 * `evals/tasks/<dataset>/<version>/composition.json` declares how many labels of
 * each class a version contains, how many families they come from and how many
 * are distractors. The counts are a pre-registered contract, compared with the
 * labels actually present; a one-sided version cannot be declared.
 *
 * This module owns only the file: what it must contain, where it may live, and
 * how to read it. Counting lives in `composition-units.ts`, the rules in
 * `composition-rules.ts`, and the whole-tree coordinator in `composition.ts`.
 */

/** One unit is either one routing label or one entry of `speakerLabels`. */
export const compositionUnitSchema = z.enum(['routing_outcome', 'speaker_label'])
export type CompositionUnitKind = z.infer<typeof compositionUnitSchema>

/** Pre-registered class counts. `mixed` is counted and never folded into a class rate. */
export const compositionClassesSchema = z.strictObject({
  speak: z.int().nonnegative(),
  silence: z.int().nonnegative(),
  mixed: z.int().nonnegative(),
})

export const compositionSliceSchema = z.strictObject({
  classes: compositionClassesSchema,
  minFamilies: z.int().nonnegative(),
  maxPerFamily: z.int().nonnegative(),
  minDistractors: z.int().nonnegative(),
})

export type CompositionClasses = z.infer<typeof compositionClassesSchema>
export type CompositionSlice = z.infer<typeof compositionSliceSchema>

const compositionLanguagesSchema = z.strictObject({
  en: compositionSliceSchema.optional(),
  fr: compositionSliceSchema.optional(),
})

const compositionSplitsSchema = z.strictObject({
  calibration: compositionLanguagesSchema.optional(),
  holdout: compositionLanguagesSchema.optional(),
})

export const compositionFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  dataset: z.string().min(1),
  version: z.string().min(1),
  unit: compositionUnitSchema,
  splits: compositionSplitsSchema,
})

export type CompositionFile = z.infer<typeof compositionFileSchema>

export const COMPOSITION_FILE_NAME = 'composition.json'

/** The one reserved path for a version's composition. */
export function compositionPath(dataset: string, version: string): string {
  return `evals/tasks/${dataset}/${version}/${COMPOSITION_FILE_NAME}`
}

export interface CompositionLocation {
  readonly dataset: string
  readonly version: string
  readonly scope: string
}

/**
 * Parse `tasks/<dataset>/<version>/composition.json` exactly. Any other
 * `composition.json` location returns `undefined` so the walker can keep
 * reporting `INVALID_LAYOUT` for it.
 */
export function parseCompositionPath(pathInEvals: string): CompositionLocation | undefined {
  const [kind, dataset, version, file, ...rest] = pathInEvals.split('/')
  if (kind !== 'tasks' || file !== COMPOSITION_FILE_NAME || rest.length > 0) return undefined
  if (!dataset || !version) return undefined
  return { dataset, version, scope: `${dataset}/${version}` }
}

/** The scope key a task or a file belongs to. */
export function compositionScope(dataset: string, version: string): string {
  return `${dataset}/${version}`
}

export type CompositionParseResult =
  | { readonly ok: true; readonly composition: CompositionFile }
  | { readonly ok: false; readonly issues: readonly string[] }

/** Parse one composition value. A failure returns the issues, never a throw. */
export function parseComposition(value: unknown): CompositionParseResult {
  const parsed = compositionFileSchema.safeParse(value)
  if (parsed.success) return { ok: true, composition: parsed.data }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => `${renderFieldPath(issue.path)}: ${issue.message}`),
  }
}

/** One composition file the walker found. */
export interface CompositionFileRecord {
  /** Path relative to the repository root, always with `/` separators. */
  readonly path: string
  /** The dataset directory the file sits under. */
  readonly dataset: string
  /** The version directory the file sits under. */
  readonly version: string
  /**
   * Parsed JSON. `undefined` means the file could not be parsed and the walker
   * already reported it, so the pair counts as declared but is not re-checked.
   */
  readonly value?: unknown
}
