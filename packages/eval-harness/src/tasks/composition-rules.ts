import type {
  CompositionFile,
  CompositionFileRecord,
  CompositionSlice,
} from './composition-file.js'
import { compositionPath, parseComposition } from './composition-file.js'
import { isGrandfathered } from './composition-grandfather.js'
import {
  declaredSlices,
  resolveCompositionUnits,
  sliceKey,
  type CompositionLabelRecord,
  type CompositionTaskRecord,
  type CompositionUnit,
} from './composition-units.js'
import { LABEL_CLASSES } from './label-class.js'
import type { TaskViolation } from './violations.js'

/**
 * The composition rules, applied to one dataset/version pair (M3c P2).
 *
 * `checkPair` is the pair-level coordinator: it decides whether the file exists
 * and parses, then calls one function per rule. Each rule reports violations and
 * returns; nothing here reads the filesystem or the clock.
 */

export interface CompositionPair {
  readonly dataset: string
  readonly version: string
  /** Mutable while the coordinator indexes the tree; read-only to every check. */
  tasks: CompositionTaskRecord[]
}

/**
 * Check one pair: missing file, parse, identity, slice coverage, then every
 * declared slice through the four rules.
 */
export function checkPair(
  pair: CompositionPair,
  file: CompositionFileRecord | undefined,
  labels: readonly CompositionLabelRecord[],
  violations: TaskViolation[],
): void {
  if (file === undefined) {
    reportMissingComposition(pair, violations)
    return
  }
  // A file that failed to parse was already reported by the walker.
  if (file.value === undefined) return

  const composition = parseFile(file, violations)
  if (composition === undefined) return

  const treeSlices = treeSlicesOf(pair)
  checkIdentity(composition, pair, file.path, violations)
  checkSliceCoverage(composition, treeSlices, file.path, violations)
  checkDeclaredSlices(composition, treeSlices, labels, pair, file.path, violations)
}

function reportMissingComposition(pair: CompositionPair, violations: TaskViolation[]): void {
  if (isGrandfathered(pair.dataset, pair.version)) return
  violations.push({
    path: compositionPath(pair.dataset, pair.version),
    code: 'COMPOSITION_MISSING',
    message: `"${pair.dataset}/${pair.version}" declares no composition and is not on the grandfather list`,
  })
}

function parseFile(
  file: CompositionFileRecord,
  violations: TaskViolation[],
): CompositionFile | undefined {
  const parsed = parseComposition(file.value)
  if (parsed.ok) return parsed.composition
  for (const issue of parsed.issues) {
    violations.push({ path: file.path, code: 'INVALID_COMPOSITION', message: issue })
  }
  return undefined
}

function checkIdentity(
  composition: CompositionFile,
  pair: CompositionPair,
  filePath: string,
  violations: TaskViolation[],
): void {
  if (composition.dataset !== pair.dataset) {
    violations.push({
      path: filePath,
      code: 'COMPOSITION_MISMATCH',
      message: `declared dataset "${composition.dataset}" does not match the path "${pair.dataset}"`,
    })
  }
  if (composition.version !== pair.version) {
    violations.push({
      path: filePath,
      code: 'COMPOSITION_MISMATCH',
      message: `declared version "${composition.version}" does not match the path "${pair.version}"`,
    })
  }
}

function treeSlicesOf(pair: CompositionPair): Set<string> {
  const treeSlices = new Set<string>()
  for (const task of pair.tasks) treeSlices.add(sliceKey(task.split, task.lang))
  return treeSlices
}

function checkSliceCoverage(
  composition: CompositionFile,
  treeSlices: ReadonlySet<string>,
  filePath: string,
  violations: TaskViolation[],
): void {
  reportUndeclaredSlices(composition, treeSlices, filePath, violations)
  reportSlicesWithoutTasks(composition, treeSlices, filePath, violations)
}

function reportUndeclaredSlices(
  composition: CompositionFile,
  treeSlices: ReadonlySet<string>,
  filePath: string,
  violations: TaskViolation[],
): void {
  const declared = new Set(
    declaredSlices(composition).map((entry) => sliceKey(entry.split, entry.lang)),
  )
  for (const key of [...treeSlices].sort()) {
    if (declared.has(key)) continue
    violations.push({
      path: filePath,
      code: 'COMPOSITION_MISMATCH',
      message: `${key} has tasks but the composition does not declare it`,
    })
  }
}

function reportSlicesWithoutTasks(
  composition: CompositionFile,
  treeSlices: ReadonlySet<string>,
  filePath: string,
  violations: TaskViolation[],
): void {
  for (const { split, lang } of declaredSlices(composition)) {
    const key = sliceKey(split, lang)
    if (treeSlices.has(key)) continue
    violations.push({
      path: filePath,
      code: 'COMPOSITION_MISMATCH',
      message: `${key} is declared but the task tree has no tasks for it`,
    })
  }
}

function checkDeclaredSlices(
  composition: CompositionFile,
  treeSlices: ReadonlySet<string>,
  labels: readonly CompositionLabelRecord[],
  pair: CompositionPair,
  filePath: string,
  violations: TaskViolation[],
): void {
  const units = resolveCompositionUnits(composition.unit, pair.tasks, labels)
  for (const { split, lang, slice } of declaredSlices(composition)) {
    const key = sliceKey(split, lang)
    if (!treeSlices.has(key)) continue
    const sliceUnits = units.filter((unit) => unit.split === split && unit.lang === lang)
    checkSlice(key, slice, sliceUnits, filePath, violations)
  }
}

/** Apply every rule to one declared slice. */
function checkSlice(
  key: string,
  slice: CompositionSlice,
  units: readonly CompositionUnit[],
  filePath: string,
  violations: TaskViolation[],
): void {
  checkClassCounts(key, slice, units, filePath, violations)
  checkTwoSided(key, slice, filePath, violations)
  checkMinFamilies(key, slice, units, filePath, violations)
  checkMaxPerFamily(key, slice, units, filePath, violations)
  checkDistractors(key, slice, units, filePath, violations)
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

function checkMinFamilies(
  key: string,
  slice: CompositionSlice,
  units: readonly CompositionUnit[],
  filePath: string,
  violations: TaskViolation[],
): void {
  if (slice.minFamilies === 0) return
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

function checkMaxPerFamily(
  key: string,
  slice: CompositionSlice,
  units: readonly CompositionUnit[],
  filePath: string,
  violations: TaskViolation[],
): void {
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
