import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  compositionPath,
  declaredSlices,
  parseComposition,
  resolveCompositionUnits,
  sliceKey,
  type CompositionLabelRecord,
  type CompositionSlice,
  type CompositionTaskRecord,
} from '../tasks/composition.js'
import { LABEL_CLASSES } from '../tasks/label-class.js'
import type { GoldenEntry, Lang, Split } from '../tasks/schema.js'
import { HarnessConfigError, errorMessage } from './errors.js'
import type { LoadedTask } from './task-loader.js'

/**
 * Run-time composition presence guard (M3c P2).
 *
 * `validate:tasks` checks the whole tree before a run, exact counts included.
 * This guard checks only what filtering can break: after the split, language and
 * locale filters, every class a version declares must still have at least one
 * selected unit. Exact-count matching stays in the walker, so a deliberate
 * locale or id subset is not rejected here.
 *
 * A pair without a composition file is skipped, so the grandfathered versions
 * keep running. A composition that exists but is broken, mislabelled or missing a
 * selected slice is a configuration error: a run against an unreadable contract
 * cannot be trusted, and `errors.ts` maps that to exit code 2 before any trial.
 */

export interface CompositionGuardInput {
  /** Repository root: the directory containing `evals/`. */
  readonly repoRoot: string
  readonly dataset: string
  readonly version: string
  /** Tasks left after the manifest's split, language and locale filters. */
  readonly tasks: readonly LoadedTask[]
  /** Golden entries loaded for the same version and languages. */
  readonly goldens: readonly GoldenEntry[]
}

export async function assertCompositionCoversSelection(
  input: CompositionGuardInput,
): Promise<void> {
  const path = compositionPath(input.dataset, input.version)
  const raw = await readComposition(join(resolve(input.repoRoot), path))
  if (raw === undefined) return

  const parsed = parseComposition(raw)
  if (!parsed.ok) {
    throw new HarnessConfigError(`${path} is not a valid composition: ${parsed.issues.join('; ')}`)
  }

  const composition = parsed.composition
  if (composition.dataset !== input.dataset || composition.version !== input.version) {
    throw new HarnessConfigError(
      `${path} declares "${composition.dataset}/${composition.version}", not "${input.dataset}/${input.version}"`,
    )
  }

  const declared = new Map<string, CompositionSlice>(
    declaredSlices(composition).map((entry) => [sliceKey(entry.split, entry.lang), entry.slice]),
  )
  const units = resolveCompositionUnits(
    composition.unit,
    input.tasks.map((loaded) => toTaskRecord(loaded, input.dataset, input.version)),
    input.goldens.map((entry) => toLabelRecord(entry, input.version)),
  )

  for (const { split, lang } of selectedSlices(input.tasks)) {
    const key = sliceKey(split, lang)
    const slice = declared.get(key)
    if (slice === undefined) {
      throw new HarnessConfigError(
        `${path} does not declare ${key}; a selected split and language must be in the composition`,
      )
    }
    for (const klass of LABEL_CLASSES) {
      if (slice.classes[klass] === 0) continue
      const kept = units.some(
        (unit) => unit.split === split && unit.lang === lang && unit.labelClass === klass,
      )
      if (kept) continue
      throw new HarnessConfigError(
        `${path} declares class "${klass}" for ${key}, but the filtered selection keeps no unit of that class`,
      )
    }
  }
}

function selectedSlices(tasks: readonly LoadedTask[]): { split: Split; lang: Lang }[] {
  const selected = new Map<string, { split: Split; lang: Lang }>()
  for (const { task } of tasks) {
    selected.set(sliceKey(task.split, task.lang), { split: task.split, lang: task.lang })
  }
  return [...selected.values()].sort((left, right) =>
    sliceKey(left.split, left.lang).localeCompare(sliceKey(right.split, right.lang)),
  )
}

function toTaskRecord(loaded: LoadedTask, dataset: string, version: string): CompositionTaskRecord {
  return {
    dataset,
    version,
    lang: loaded.task.lang,
    locale: loaded.task.locale ?? loaded.task.lang,
    split: loaded.task.split,
    id: loaded.task.id,
    path: loaded.relativePath,
  }
}

function toLabelRecord(entry: GoldenEntry, version: string): CompositionLabelRecord {
  return {
    lang: entry.lang,
    version,
    locale: entry.locale ?? entry.lang,
    split: entry.split,
    taskId: entry.taskId,
    routingOutcome: entry.routingOutcome,
    speakerLabels: entry.speakerLabels,
  }
}

/** `undefined` means no composition file: the legacy path, not an error. */
async function readComposition(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw new HarnessConfigError(`cannot read composition ${path}: ${errorMessage(error)}`)
  }

  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new HarnessConfigError(`composition ${path} is not valid JSON: ${errorMessage(error)}`)
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
