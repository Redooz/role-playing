import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CompositionSlice } from '../tasks/composition-file.js'
import { compositionPath, parseComposition } from '../tasks/composition-file.js'
import { isGrandfathered } from '../tasks/composition-grandfather.js'
import {
  declaredSlices,
  resolveCompositionUnits,
  sliceKey,
  type CompositionLabelRecord,
  type CompositionTaskRecord,
} from '../tasks/composition-units.js'
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
 * A pair with no composition file is skipped only when it is grandfathered;
 * any other version that reaches a run without a contract is a configuration
 * error, so a layer that adds a version cannot skip the rule by not running
 * `validate:tasks` first. A composition that exists but is broken, mislabelled
 * or missing a selected slice is also a configuration error: a run against an
 * unreadable contract cannot be trusted, and `errors.ts` maps that to exit code
 * 2 before any trial.
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
  if (raw === undefined) {
    if (isGrandfathered(input.dataset, input.version)) return
    throw new HarnessConfigError(
      `${path} is missing; only a grandfathered version may run without a composition`,
    )
  }

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
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw new HarnessConfigError(`cannot read composition ${path}: ${errorMessage(error)}`)
  }

  try {
    // `Buffer#toString()` decodes UTF-8 by default. Reading a Buffer avoids an
    // encoding literal at the call site, so the decode has one obvious form.
    return JSON.parse(bytes.toString()) as unknown
  } catch (error) {
    throw new HarnessConfigError(`composition ${path} is not valid JSON: ${errorMessage(error)}`)
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
