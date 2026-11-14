import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { goldenEntrySchema, taskEntrySchema, type Split } from './schema.js'
import { parseGoldenLocation, parseTaskLocation, relativeToEvals } from './layout.js'
import {
  checkGoldenAgreement,
  checkGoldenTaskLink,
  registerTaskForGolden,
  taskLinkKey,
} from './golden-link.js'
import {
  checkRequiredMetadata,
  checkRoutingReferences,
  checkSessionReferences,
} from './task-references.js'
import {
  collectDuplicateIds,
  collectSplitLeakage,
  registerId,
  registerSpeaker,
  type IdIndex,
  type SpeakerIndex,
} from './tree-index.js'
import { pushSchemaViolations, type TaskViolation } from './violations.js'

export { formatViolation } from './violations.js'
export type { TaskViolation, ViolationCode } from './violations.js'

/**
 * Filesystem validator for the task/golden tree (M0 D5, gate G3).
 *
 * `rootDir` is the repository root, i.e. the directory that contains `evals/`.
 * The walker enforces this layout:
 *
 * ```text
 * evals/tasks/<dataset>/<version>/<lang>/.../*.json   (task entries)
 * evals/golden/<lang>/<version>/.../*.json               (golden entries)
 * ```
 *
 * Violations are returned, never thrown: the eval-harness CLI prints them and CI
 * fails when the list is non-empty. Every violation names the file path relative
 * to `rootDir` using `/` separators, a stable machine-readable `code`, and a
 * human message that includes the failing JSON field for schema errors.
 *
 * Split scope (§4.6.5): the "no speaker in both splits" rule is evaluated **per
 * dataset + version + language**. The same `speakerId` may legitimately appear
 * in another dataset, another version, or the other language; only within one
 * `<dataset>/<version>/<lang>` scope is it leakage that inflates scores.
 *
 * Duplicate ids are scoped the same way for tasks (`dataset/version/lang`) and
 * by `<lang>/<version>` for golden entries, because those are the namespaces a
 * consumer selects when it loads a split.
 *
 * Missing `evals/tasks` or `evals/golden` subtrees are treated as empty; only
 * a missing `evals/` root is itself a violation.
 */
export async function validateTaskTree(rootDir: string): Promise<TaskViolation[]> {
  const root = resolve(rootDir)
  const evalsDir = join(root, 'evals')

  if (!(await isDirectory(evalsDir))) {
    return [
      {
        path: 'evals',
        code: 'EVALS_DIR_MISSING',
        message: `expected an evals/ directory under ${root}`,
      },
    ]
  }

  const violations: TaskViolation[] = []
  const taskFiles = await collectJsonFiles(join(evalsDir, 'tasks'), 'evals/tasks', violations)
  const goldenFiles = await collectJsonFiles(join(evalsDir, 'golden'), 'evals/golden', violations)

  const ids: IdIndex = new Map()
  const speakers: SpeakerIndex = new Map()
  const tasksByLangVersion = new Map<
    string,
    {
      split: Split
      path: string
      routing?: { eligiblePersonaIds: readonly string[] }
    }[]
  >()
  const routingLabelKeys = new Set<string>()

  for (const path of taskFiles) {
    const location = parseTaskLocation(relativeToEvals(path))
    if (location === undefined) {
      violations.push({
        path,
        code: 'INVALID_LAYOUT',
        message:
          'task files must live at evals/tasks/<dataset>/<version>/<lang>/**.json with lang in en|fr',
      })
      continue
    }

    const raw = await readJsonFile(root, path)
    if (raw.violation !== undefined) {
      violations.push(raw.violation)
      continue
    }

    checkRequiredMetadata(raw.value, path, violations)

    const parsed = taskEntrySchema.safeParse(raw.value)
    if (!parsed.success) {
      pushSchemaViolations(violations, path, parsed.error.issues)
      continue
    }

    const entry = parsed.data
    if (entry.lang !== location.lang) {
      violations.push({
        path,
        code: 'LANG_PATH_MISMATCH',
        message: `entry lang is "${entry.lang}" but the path says "${location.lang}"`,
      })
    }

    registerId(
      ids,
      `${location.scope}\u0000${entry.locale ?? entry.lang}\u0000${entry.id}`,
      entry.id,
      `${location.scope}/${entry.locale ?? entry.lang}`,
      path,
    )
    registerSpeaker(speakers, location.scope, entry.speakerId, path, entry.split)
    registerTaskForGolden(tasksByLangVersion, location, entry, path)
    checkSessionReferences(entry, path, violations)
    checkRoutingReferences(entry, path, violations)
  }

  for (const path of goldenFiles) {
    const location = parseGoldenLocation(relativeToEvals(path))
    if (location === undefined) {
      violations.push({
        path,
        code: 'INVALID_LAYOUT',
        message:
          'golden files must live at evals/golden/<lang>/<version>/**.json with lang in en|fr',
      })
      continue
    }

    const raw = await readJsonFile(root, path)
    if (raw.violation !== undefined) {
      violations.push(raw.violation)
      continue
    }

    // Report the stable-without-agreement rule under its own code, then suppress
    // the duplicate schema issue for the same field so CI output stays readable.
    const agreementMissing = checkGoldenAgreement(raw.value, path, violations)

    const parsed = goldenEntrySchema.safeParse(raw.value)
    if (!parsed.success) {
      const issues = parsed.error.issues.filter(
        (issue) => !(agreementMissing && issue.path[0] === 'annotatorAgreement'),
      )
      pushSchemaViolations(violations, path, issues)
      continue
    }

    const entry = parsed.data
    if (entry.lang !== location.lang) {
      violations.push({
        path,
        code: 'LANG_PATH_MISMATCH',
        message: `entry lang is "${entry.lang}" but the path says "${location.lang}"`,
      })
    }

    registerId(
      ids,
      `${location.scope}\u0000${entry.locale ?? entry.lang}\u0000${entry.id}`,
      entry.id,
      `${location.scope}/${entry.locale ?? entry.lang}`,
      path,
    )
    checkGoldenTaskLink(entry, location, path, tasksByLangVersion, violations)
    if (entry.routingOutcome !== undefined && entry.taskId !== undefined) {
      routingLabelKeys.add(
        `${taskLinkKey(
          entry.lang,
          location.version,
          entry.locale ?? entry.lang,
          entry.taskId,
        )}\u0000${entry.split}`,
      )
    }
  }

  for (const [key, records] of tasksByLangVersion) {
    for (const record of records) {
      if (record.routing === undefined) continue
      if (!routingLabelKeys.has(`${key}\u0000${record.split}`)) {
        violations.push({
          path: record.path,
          code: 'ROUTING_LABEL_MISSING',
          message: 'a routing task requires a routingOutcome golden label in its split',
        })
      }
    }
  }

  violations.push(...collectDuplicateIds(ids))
  violations.push(...collectSplitLeakage(speakers))

  return violations.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  )
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Recursively collects `.json` files, sorted by path. Symlinks are not followed,
 * so the walker cannot cycle. Unreadable directories become violations instead
 * of exceptions.
 */
async function collectJsonFiles(
  directory: string,
  displayDirectory: string,
  violations: TaskViolation[],
): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return []
    violations.push({
      path: displayDirectory,
      code: 'UNREADABLE_DIRECTORY',
      message: `cannot read directory: ${errorMessage(error)}`,
    })
    return []
  }

  const files: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const displayPath = `${displayDirectory}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...(await collectJsonFiles(join(directory, entry.name), displayPath, violations)))
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(displayPath)
    }
  }
  return files.sort()
}

interface ReadResult {
  value?: unknown
  violation?: TaskViolation
}

async function readJsonFile(root: string, displayPath: string): Promise<ReadResult> {
  let text: string
  try {
    text = await readFile(join(root, displayPath), 'utf8')
  } catch (error) {
    return {
      violation: {
        path: displayPath,
        code: 'UNREADABLE_FILE',
        message: `cannot read file: ${errorMessage(error)}`,
      },
    }
  }

  try {
    return { value: JSON.parse(text) as unknown }
  } catch (error) {
    return {
      violation: {
        path: displayPath,
        code: 'INVALID_JSON',
        message: `invalid JSON: ${errorMessage(error)}`,
      },
    }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
