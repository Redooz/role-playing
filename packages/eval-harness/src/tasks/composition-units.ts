import type { CompositionFile, CompositionSlice, CompositionUnitKind } from './composition-file.js'
import { labelClass, type LabelClass } from './label-class.js'
import { LANGS, SPLITS, type Lang, type Split } from './schema.js'

/**
 * Counting units for a composition (M3c P2).
 *
 * A unit is one label the composition counts: one `routingOutcome` or one entry
 * of `speakerLabels`. This module turns the tree's task and golden records into
 * units and exposes the declared `(split, language)` slices, so the rules and
 * the run-time guard read the same numbers.
 */

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
  const byTask = labelsByTask(labels)
  const units: CompositionUnit[] = []
  for (const task of tasks) {
    const records = byTask.get(labelKey(task.lang, task.version, task.locale, task.id))
    if (records === undefined) continue
    for (const record of records) {
      if (record.split !== task.split) continue
      collectRecordUnits(unit, task, record, units)
    }
  }
  return units
}

/** Group label records by the task they annotate. */
function labelsByTask(
  labels: readonly CompositionLabelRecord[],
): Map<string, CompositionLabelRecord[]> {
  const byTask = new Map<string, CompositionLabelRecord[]>()
  for (const label of labels) {
    if (label.taskId === undefined) continue
    const key = labelKey(label.lang, label.version, label.locale, label.taskId)
    const bucket = byTask.get(key)
    if (bucket === undefined) byTask.set(key, [label])
    else bucket.push(label)
  }
  return byTask
}

/** Append the units one matching golden record contributes for the chosen kind. */
function collectRecordUnits(
  unit: CompositionUnitKind,
  task: CompositionTaskRecord,
  record: CompositionLabelRecord,
  units: CompositionUnit[],
): void {
  if (unit === 'routing_outcome') {
    if (record.routingOutcome !== undefined) {
      units.push(toUnit(task, record.routingOutcome, record.path))
    }
    return
  }
  for (const label of record.speakerLabels ?? []) {
    units.push(toUnit(task, label, record.path))
  }
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
