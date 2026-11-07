import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { goldenEntrySchema, type GoldenEntry, type Lang } from './schema.js'

/**
 * Load golden reference entries for one dataset version (M0.1 helper).
 *
 * The layout is `evals/golden/<lang>/<version>/**\/*.json`. Missing directories
 * are empty, not errors: golden labels are optional and M0 only has a few.
 * Results are sorted so an export plan is deterministic.
 */
export async function loadGoldenEntries(
  repoRoot: string,
  options: { readonly version: string; readonly languages: readonly Lang[] },
): Promise<GoldenEntry[]> {
  const root = resolve(repoRoot)
  const entries: GoldenEntry[] = []

  for (const lang of options.languages) {
    const directory = join(root, 'evals', 'golden', lang, options.version)
    for (const file of await collectJsonFiles(directory)) {
      const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
      entries.push(goldenEntrySchema.parse(raw))
    }
  }

  return entries.sort((left, right) => {
    if (left.lang !== right.lang) return left.lang < right.lang ? -1 : 1
    if (left.id !== right.id) return left.id < right.id ? -1 : 1
    return 0
  })
}

/** `lang:taskId` → golden entry, for the tasks that have one. */
export function goldenIndexByTask(entries: readonly GoldenEntry[]): Map<string, GoldenEntry> {
  const index = new Map<string, GoldenEntry>()
  for (const entry of entries) {
    if (entry.taskId === undefined) continue
    index.set(`${entry.lang}:${entry.taskId}`, entry)
  }
  return index
}

async function collectJsonFiles(directory: string): Promise<string[]> {
  let children: Dirent[]
  try {
    children = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw error
  }

  const files: string[] = []
  for (const child of [...children].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const path = join(directory, child.name)
    if (child.isDirectory()) files.push(...(await collectJsonFiles(path)))
    else if (child.isFile() && child.name.endsWith('.json')) files.push(path)
  }
  return files
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
