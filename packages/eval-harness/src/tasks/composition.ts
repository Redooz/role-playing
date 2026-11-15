import { z } from 'zod'
import { LABEL_CLASSES, labelClass, type LabelClass } from './label-class.js'
import { LANGS, SPLITS, type Lang, type Split } from './schema.js'
import { renderFieldPath, type TaskViolation } from './violations.js'

/**
 * Per-version composition contract (M3c P2).
 *
 * `evals/tasks/<dataset>/<version>/composition.json` is the reserved file that
 * declares how many labels of each class a version contains, how many families
 * they come from, and how many are distractors. The counts are a pre-registered
 * contract: they are compared with the labels actually present, so a one-sided
 * version cannot be declared, and a version cannot silently lose a class.
 *
 * This module owns one job: parse a composition and check it against the steps
 * of the task/golden tree. It reads records, never the filesystem, so the walker
 * (`validate.ts`) and the run-time guard (`runner/composition-guard.ts`) share
 * the same rules. The schema is code-only on purpose: like the other derived
 * contracts, the committed JSON Schemas under `evals/schemas/` describe the
 * layout entries (`task.schema.json`, `golden.schema.json`) and are generated
 * from `schema.ts`, not from this module.
 *
 * Zero means "no requirement", so `minFamilies: 0`, `maxPerFamily: 0` and
 * `minDistractors: 0` leave the corresponding rule asleep.
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

export function compositionScope(dataset: string, version: string): string {
  return `${dataset}/${version}`
}

/**
 * The dataset/version pairs that predate the rule. They are the only versions
 * allowed to omit `composition.json`; a pair is grandfathered by name, never by
 * being old, so a new version of the same dataset still needs the file.
 */
export const GRANDFATHERED_COMPOSITIONS = [
  'synthetic-routing/1.0.0',
  'synthetic-multi-persona-session/m3b-v1',
  'synthetic-workplace/v1',
  'synthetic-workplace-session/v1',
] as const

export function isGrandfathered(dataset: string, version: string): boolean {
  return (GRANDFATHERED_COMPOSITIONS as readonly string[]).includes(`${dataset}/${version}`)
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

/** The label fields the class, family and distractor rules read. */
export interface CompositionLabelFields {
  readonly acceptablePersonaIds: readonly string[]
  readonly allowUserYield: boolean
  readonly family?: string | undefined
  readonly distractor?: boolean | undefined
}

/** One task in the tree, as the composition rules need to see it. */
export interface CompositionTaskRecord {
  readonly dataset: string
  readonly version: string
  readonly lang: Lang
  readonly locale: string
  readonly split: Split
  readonly id: string
  readonly path: string
}

/** One golden entry in the tree; only its labels matter here. */
export interface CompositionLabelRecord {
  readonly lang: Lang
  readonly version: string
  readonly locale: string
  readonly split: Split
  readonly taskId?: string | undefined
  readonly routingOutcome?: CompositionLabelFields | undefined
  readonly speakerLabels?: readonly CompositionLabelFields[] | undefined
  /** Golden file path; omitted when the caller does not track one (run-time guard). */
  readonly path?: string | undefined
}

/** One counted label: the unit of `classes`, `family` and `distractor`. */
export interface CompositionUnit {
  readonly split: Split
  readonly lang: Lang
  readonly labelClass: LabelClass
  readonly family?: string | undefined
  readonly distractor?: boolean | undefined
  /** Golden file path, when the source record carried one. */
  readonly path?: string | undefined
}

/**
 * Resolve the units a composition counts.
 *
 * A unit is attached to its task, so its slice comes from the task tree, and a
 * golden entry whose split disagrees with its task is skipped: that mismatch is
 * already `GOLDEN_TASK_SPLIT_MISMATCH`, and counting it would move a class into
 * a slice the task does not belong to.
 */
export function resolveCompositionUnits(
  unit: CompositionUnitKind,
  tasks: readonly CompositionTaskRecord[],
  labels: readonly CompositionLabelRecord[],
): CompositionUnit[] {
  const byTask = new Map<string, CompositionLabelRecord[]>()
  for (const label of labels) {
    if (label.taskId === undefined) continue
    const key = labelKey(label.lang, label.version, label.locale, label.taskId)
    const bucket = byTask.get(key)
    if (bucket === undefined) byTask.set(key, [label])
    else bucket.push(label)
  }

  const units: CompositionUnit[] = []
  for (const task of tasks) {
    const records = byTask.get(labelKey(task.lang, task.version, task.locale, task.id))
    if (records === undefined) continue
    for (const record of records) {
      if (record.split !== task.split) continue
      if (unit === 'routing_outcome') {
        if (record.routingOutcome !== undefined) {
          units.push(toUnit(task, record.routingOutcome, record.path))
        }
        continue
      }
      for (const label of record.speakerLabels ?? []) {
        units.push(toUnit(task, label, record.path))
      }
    }
  }
  return units
}

function toUnit(
  task: CompositionTaskRecord,
  label: CompositionLabelFields,
  path: string | undefined,
): CompositionUnit {
  return {
    split: task.split,
    lang: task.lang,
    labelClass: labelClass(label),
    family: label.family,
    distractor: label.distractor,
    path,
  }
}

function labelKey(lang: string, version: string, locale: string, taskId: string): string {
  return `${lang}\u0000${version}\u0000${locale}\u0000${taskId}`
}

export interface DeclaredSlice {
  readonly split: Split
  readonly lang: Lang
  readonly slice: CompositionSlice
}

/** Every `(split, lang)` a composition declares, in a stable order. */
export function declaredSlices(composition: CompositionFile): DeclaredSlice[] {
  const declared: DeclaredSlice[] = []
  for (const split of SPLITS) {
    const languages = composition.splits[split]
    if (languages === undefined) continue
    for (const lang of LANGS) {
      const slice = languages[lang]
      if (slice === undefined) continue
      declared.push({ split, lang, slice })
    }
  }
  return declared
}

export function sliceKey(split: Split, lang: Lang): string {
  return `${split}/${lang}`
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

export interface CompositionTree {
  readonly tasks: readonly CompositionTaskRecord[]
  readonly labels: readonly CompositionLabelRecord[]
  /** Composition scope (`dataset/version`) → the file found there. */
  readonly files: ReadonlyMap<string, CompositionFileRecord>
}

/**
 * Check every version in the tree. A pair with no composition is a violation
 * unless it is grandfathered; a pair with one is checked rule by rule. The
 * caller sorts the violations, so order here only has to be deterministic.
 */
export function checkCompositions(tree: CompositionTree, violations: TaskViolation[]): void {
  const pairs = new Map<string, PairTasks>()
  for (const task of tree.tasks) {
    const scope = compositionScope(task.dataset, task.version)
    const pair = pairs.get(scope)
    if (pair === undefined) {
      pairs.set(scope, { dataset: task.dataset, version: task.version, tasks: [task] })
    } else {
      pair.tasks.push(task)
    }
  }

  for (const [scope, file] of tree.files) {
    if (pairs.has(scope)) continue
    pairs.set(scope, { dataset: file.dataset, version: file.version, tasks: [] })
  }

  for (const [scope, pair] of [...pairs].sort(([left], [right]) => left.localeCompare(right))) {
    const file = tree.files.get(scope)
    if (file === undefined) {
      if (isGrandfathered(pair.dataset, pair.version)) continue
      violations.push({
        path: compositionPath(pair.dataset, pair.version),
        code: 'COMPOSITION_MISSING',
        message: `"${scope}" declares no composition and is not on the grandfather list`,
      })
      continue
    }
    if (file.value === undefined) continue
    checkPair(pair, file, tree.labels, violations)
  }
}

interface PairTasks {
  readonly dataset: string
  readonly version: string
  readonly tasks: CompositionTaskRecord[]
}

function checkPair(
  pair: PairTasks,
  file: CompositionFileRecord,
  labels: readonly CompositionLabelRecord[],
  violations: TaskViolation[],
): void {
  const parsed = parseComposition(file.value)
  if (!parsed.ok) {
    for (const issue of parsed.issues) {
      violations.push({ path: file.path, code: 'INVALID_COMPOSITION', message: issue })
    }
    return
  }

  const composition = parsed.composition
  if (composition.dataset !== pair.dataset) {
    violations.push({
      path: file.path,
      code: 'COMPOSITION_MISMATCH',
      message: `declared dataset "${composition.dataset}" does not match the path "${pair.dataset}"`,
    })
  }
  if (composition.version !== pair.version) {
    violations.push({
      path: file.path,
      code: 'COMPOSITION_MISMATCH',
      message: `declared version "${composition.version}" does not match the path "${pair.version}"`,
    })
  }

  const treeSlices = new Set<string>()
  for (const task of pair.tasks) treeSlices.add(sliceKey(task.split, task.lang))

  const declared = declaredSlices(composition)
  const declaredKeys = new Set(declared.map((entry) => sliceKey(entry.split, entry.lang)))

  for (const key of [...treeSlices].sort()) {
    if (declaredKeys.has(key)) continue
    violations.push({
      path: file.path,
      code: 'COMPOSITION_MISMATCH',
      message: `${key} has tasks but the composition does not declare it`,
    })
  }

  const units = resolveCompositionUnits(composition.unit, pair.tasks, labels)

  for (const { split, lang, slice } of declared) {
    const key = sliceKey(split, lang)
    if (!treeSlices.has(key)) {
      violations.push({
        path: file.path,
        code: 'COMPOSITION_MISMATCH',
        message: `${key} is declared but the task tree has no tasks for it`,
      })
      continue
    }
    const sliceUnits = units.filter((unit) => unit.split === split && unit.lang === lang)
    checkClassCounts(key, slice, sliceUnits, file.path, violations)
    checkTwoSided(key, slice, file.path, violations)
    checkFamilies(key, slice, sliceUnits, file.path, violations)
    checkDistractors(key, slice, sliceUnits, file.path, violations)
  }
}

function checkClassCounts(
  key: string,
  slice: CompositionSlice,
  units: readonly CompositionUnit[],
  filePath: string,
  violations: TaskViolation[],
): void {
  for (const klass of LABEL_CLASSES) {
    const declared = slice.classes[klass]
    const actual = units.filter((unit) => unit.labelClass === klass).length
    if (declared === actual) continue
    violations.push({
      path: filePath,
      code: 'COMPOSITION_MISMATCH',
      message: `class "${klass}" for ${key} is declared as ${declared} but ${actual} label(s) exist`,
    })
  }
}

function checkTwoSided(
  key: string,
  slice: CompositionSlice,
  filePath: string,
  violations: TaskViolation[],
): void {
  const { speak, silence } = slice.classes
  if (speak > 0 && silence > 0) return
  violations.push({
    path: filePath,
    code: 'COMPOSITION_ONE_SIDED',
    message: `${key} declares speak ${speak} and silence ${silence}; both classes must be greater than zero`,
  })
}

function checkFamilies(
  key: string,
  slice: CompositionSlice,
  units: readonly CompositionUnit[],
  filePath: string,
  violations: TaskViolation[],
): void {
  if (slice.minFamilies > 0) {
    const families = new Set<string>()
    const missing = new Set<string>()
    for (const unit of units) {
      if (unit.family === undefined) missing.add(unit.path ?? filePath)
      else families.add(unit.family)
    }
    // The walker sorts every violation before returning it, so insertion order
    // here only has to be deterministic; sorting a Set of paths would be dead code.
    for (const path of missing) {
      violations.push({
        path,
        code: 'COMPOSITION_FAMILY',
        message: `label has no family but ${key} requires at least ${slice.minFamilies}`,
      })
    }
    if (families.size < slice.minFamilies) {
      violations.push({
        path: filePath,
        code: 'COMPOSITION_FAMILY',
        message: `${key} requires at least ${slice.minFamilies} families but the labels use ${families.size}`,
      })
    }
  }

  if (slice.maxPerFamily === 0) return
  const counts = new Map<string, number>()
  for (const unit of units) {
    if (unit.family === undefined) continue
    counts.set(unit.family, (counts.get(unit.family) ?? 0) + 1)
  }
  for (const [family, count] of counts) {
    if (count <= slice.maxPerFamily) continue
    violations.push({
      path: filePath,
      code: 'COMPOSITION_FAMILY',
      message: `family "${family}" has ${count} labels in ${key}, above maxPerFamily ${slice.maxPerFamily}`,
    })
  }
}

function checkDistractors(
  key: string,
  slice: CompositionSlice,
  units: readonly CompositionUnit[],
  filePath: string,
  violations: TaskViolation[],
): void {
  const marked = units.filter((unit) => unit.distractor === true).length
  if (marked >= slice.minDistractors) return
  violations.push({
    path: filePath,
    code: 'COMPOSITION_DISTRACTOR',
    message: `${key} requires at least ${slice.minDistractors} distractor(s) but ${marked} label(s) are marked`,
  })
}
