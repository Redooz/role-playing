import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { taskEntrySchema, type TaskEntry, type Lang } from '../tasks/schema.js'
import { errorMessage, HarnessConfigError } from './errors.js'
import type { TaskSelection } from './manifest.js'

/**
 * Task loading for the evaluation harness.
 *
 * Reads and validates the task files the manifest selects, enforces the
 * per-language and per-locale coverage rules, and orders the result
 * deterministically. A malformed or missing task is a configuration error, not
 * a failed measurement.
 */

export interface LoadedTask {
  readonly task: TaskEntry
  /** Path relative to the repository root, using `/` separators. */
  readonly relativePath: string
}

/**
 * Load and validate the tasks selected by the manifest.
 *
 * Every file is parsed against `taskEntrySchema`; a malformed task is a
 * configuration error, not a failed measurement. Each requested language must
 * contribute at least one task (§4.4: passing EN does not count for FR).
 */
export async function loadSelectedTasks(
  repoRoot: string,
  selection: TaskSelection,
): Promise<LoadedTask[]> {
  const root = resolve(repoRoot)
  const selected: LoadedTask[] = []
  const requestedLocales = new Set(selection.locales ?? selection.languages)

  for (const lang of selection.languages) {
    const directory = join(root, 'evals', 'tasks', selection.dataset, selection.version, lang)
    const files = await collectJsonFiles(directory)

    if (files.length === 0) {
      throw new HarnessConfigError(
        `no tasks found for language "${lang}" at evals/tasks/${selection.dataset}/${selection.version}/${lang}`,
      )
    }

    for (const file of files) {
      const relativePath = relative(root, file).split(sep).join('/')
      const task = await readTask(file, relativePath)

      if (task.lang !== lang) {
        throw new HarnessConfigError(
          `task ${relativePath} declares lang "${task.lang}" but lives under "${lang}"`,
        )
      }

      if (selection.splits !== undefined && !selection.splits.includes(task.split)) continue
      if (selection.ids !== undefined && !selection.ids.includes(task.id)) continue
      if (!requestedLocales.has(task.locale ?? task.lang)) continue

      selected.push({ task, relativePath })
    }
  }

  const seen = new Set<string>()
  for (const { task } of selected) {
    const key = `${task.lang}\u0000${task.locale ?? task.lang}\u0000${task.id}`
    if (seen.has(key)) {
      throw new HarnessConfigError(
        `task id "${task.id}" appears more than once in language "${task.lang}" locale "${task.locale ?? task.lang}"`,
      )
    }
    seen.add(key)
  }

  for (const lang of selection.languages) {
    if (!selected.some(({ task }) => task.lang === lang)) {
      throw new HarnessConfigError(
        `manifest selects no task for language "${lang}" after split/id/locale filters`,
      )
    }
  }

  for (const locale of requestedLocales) {
    if (!selected.some(({ task }) => (task.locale ?? task.lang) === locale)) {
      throw new HarnessConfigError(
        `manifest selects no task for locale "${locale}" after split/id filters`,
      )
    }
  }

  const languageOrder = new Map<Lang, number>(
    selection.languages.map((lang, index) => [lang, index]),
  )

  return selected.sort((left, right) => {
    const leftOrder = languageOrder.get(left.task.lang) ?? 0
    const rightOrder = languageOrder.get(right.task.lang) ?? 0
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    return compareStrings(left.task.id, right.task.id)
  })
}

async function readTask(path: string, relativePath: string): Promise<TaskEntry> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    throw new HarnessConfigError(`cannot read task ${relativePath}: ${errorMessage(error)}`)
  }

  const parsed = taskEntrySchema.safeParse(raw)
  if (!parsed.success) {
    throw new HarnessConfigError(
      `task ${relativePath} is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    )
  }

  return parsed.data
}

async function collectJsonFiles(directory: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw new HarnessConfigError(`cannot read task directory ${directory}: ${errorMessage(error)}`)
  }

  const files: string[] = []
  for (const entry of [...entries].sort((left, right) => compareStrings(left.name, right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectJsonFiles(path)))
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(path)
    }
  }

  return files.sort(compareStrings)
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
