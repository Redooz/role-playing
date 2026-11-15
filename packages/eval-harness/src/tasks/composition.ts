import { compositionScope, type CompositionFileRecord } from './composition-file.js'
import { checkPair, type CompositionPair } from './composition-rules.js'
import type { CompositionLabelRecord, CompositionTaskRecord } from './composition-units.js'
import type { TaskViolation } from './violations.js'

/**
 * Whole-tree composition coordinator (M3c P2).
 *
 * The rules for one dataset/version pair live in `composition-rules.ts`; the
 * file contract in `composition-file.ts`; counting in `composition-units.ts`.
 * This module only groups the tree by pair and hands each pair to `checkPair`,
 * so a reader can find every rule by name instead of walking one large function.
 */

export interface CompositionTree {
  readonly tasks: readonly CompositionTaskRecord[]
  readonly labels: readonly CompositionLabelRecord[]
  /** Composition scope (`dataset/version`) → the file found there. */
  readonly files: ReadonlyMap<string, CompositionFileRecord>
}

/**
 * Check every version in the tree: a pair with no composition is reported
 * unless grandfathered, and a pair with one goes through every rule.
 */
export function checkCompositions(tree: CompositionTree, violations: TaskViolation[]): void {
  for (const { scope, pair } of scopedPairs(tree)) {
    checkPair(pair, tree.files.get(scope), tree.labels, violations)
  }
}

interface ScopedPair {
  readonly scope: string
  readonly pair: CompositionPair
}

/** Group the tasks and files by `dataset/version`, in a stable order. */
function scopedPairs(tree: CompositionTree): ScopedPair[] {
  const pairs = new Map<string, CompositionPair>()
  for (const task of tree.tasks) addTask(pairs, task)
  for (const [scope, file] of tree.files) addFile(pairs, scope, file)
  return [...pairs]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([scope, pair]) => ({ scope, pair }))
}

function addTask(pairs: Map<string, CompositionPair>, task: CompositionTaskRecord): void {
  const scope = compositionScope(task.dataset, task.version)
  const existing = pairs.get(scope)
  if (existing === undefined) {
    pairs.set(scope, { dataset: task.dataset, version: task.version, tasks: [task] })
  } else {
    existing.tasks.push(task)
  }
}

function addFile(
  pairs: Map<string, CompositionPair>,
  scope: string,
  file: CompositionFileRecord,
): void {
  if (pairs.has(scope)) return
  pairs.set(scope, { dataset: file.dataset, version: file.version, tasks: [] })
}
