import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { baseLanguageOfLocale } from '@rp/shared'
import { PERSONAS_BY_ID, personaVariant } from '@rp/persona-kit'
import { SCENARIOS_BY_ID, scenarioVariant, type ScenarioVariant } from '@rp/scenario-kit'
import {
  taskEntrySchema,
  goldenEntrySchema,
  hasMeasuredAgreement,
  LANGS,
  type GoldenEntry,
  type Lang,
  type Split,
  type TaskEntry,
} from './schema.js'

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

/** Stable violation codes. The eval-harness CLI and CI output depend on these strings. */
export type ViolationCode =
  | 'EVALS_DIR_MISSING'
  | 'UNREADABLE_DIRECTORY'
  | 'UNREADABLE_FILE'
  | 'INVALID_JSON'
  | 'INVALID_LAYOUT'
  | 'SCHEMA_VIOLATION'
  | 'MISSING_PROVENANCE'
  | 'MISSING_CONSENT_SCOPE'
  | 'MISSING_ANNOTATION_VERSIONS'
  | 'LANG_PATH_MISMATCH'
  | 'LOCALE_PATH_MISMATCH'
  | 'DUPLICATE_ID'
  | 'SPLIT_LEAKAGE'
  | 'GOLDEN_AGREEMENT_MISSING'
  | 'GOLDEN_TASK_MISSING'
  | 'GOLDEN_TASK_SPLIT_MISMATCH'
  | 'GOLDEN_LOCALE_MISMATCH'
  | 'SESSION_REFERENCE_MISSING'
  | 'SESSION_VERSION_MISMATCH'
  | 'SESSION_LOCALE_MISSING'
  | 'SESSION_PERSONA_MISMATCH'

export interface TaskViolation {
  /** Path relative to `rootDir`, always with `/` separators. */
  path: string
  code: ViolationCode
  message: string
}

interface TaskLocation {
  dataset: string
  version: string
  lang: Lang
  scope: string
}

interface GoldenLocation {
  version: string
  lang: Lang
  scope: string
}

interface ReadResult {
  value?: unknown
  violation?: TaskViolation
}

/** Validates every task and golden entry under `rootDir/evals`. Never throws for data problems. */
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

  const ids = new Map<string, { id: string; scope: string; paths: string[] }>()
  const speakers = new Map<string, Map<string, { path: string; split: Split }[]>>()
  const tasksByLangVersion = new Map<string, { split: Split; path: string }[]>()

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
    const agreementMissing =
      isRecord(raw.value) &&
      raw.value['status'] === 'stable' &&
      !hasMeasuredAgreement(raw.value['annotatorAgreement'])
    if (agreementMissing) {
      violations.push({
        path,
        code: 'GOLDEN_AGREEMENT_MISSING',
        message:
          "status 'stable' requires annotatorAgreement measured with at least 2 distinct annotators, a metric, and a value",
      })
    }

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
  }

  for (const [, group] of ids) {
    if (group.paths.length < 2) continue
    const [first, ...duplicates] = group.paths
    for (const path of duplicates) {
      violations.push({
        path,
        code: 'DUPLICATE_ID',
        message: `id "${group.id}" is already used by ${first} within ${group.scope}`,
      })
    }
  }

  for (const [scope, bySpeaker] of speakers) {
    for (const [speakerId, records] of bySpeaker) {
      const splits = new Set(records.map((record) => record.split))
      if (splits.size < 2) continue
      for (const record of records) {
        violations.push({
          path: record.path,
          code: 'SPLIT_LEAKAGE',
          message: `speakerId "${speakerId}" appears in both calibration and holdout within ${scope}`,
        })
      }
    }
  }

  return violations.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  )
}

/** Convenience for CLI output; not used by the validator itself. */
export function formatViolation(violation: TaskViolation): string {
  return `${violation.path}: [${violation.code}] ${violation.message}`
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

function checkRequiredMetadata(raw: unknown, path: string, violations: TaskViolation[]): void {
  if (!isRecord(raw)) return

  if (raw['provenance'] === undefined) {
    violations.push({
      path,
      code: 'MISSING_PROVENANCE',
      message: 'provenance is required (M0 default: { "source": "synthetic" })',
    })
  }

  const consentScope = raw['consentScope']
  if (typeof consentScope !== 'string' || consentScope.length === 0) {
    violations.push({
      path,
      code: 'MISSING_CONSENT_SCOPE',
      message: 'consentScope must be a non-empty string',
    })
  }

  const annotationVersions = raw['annotationVersions']
  if (!isRecord(annotationVersions) || Object.keys(annotationVersions).length === 0) {
    violations.push({
      path,
      code: 'MISSING_ANNOTATION_VERSIONS',
      message: 'annotationVersions must be a non-empty record of name → version',
    })
  }
}

function pushSchemaViolations(
  violations: TaskViolation[],
  path: string,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): void {
  for (const issue of issues) {
    const field = renderFieldPath(issue.path)
    violations.push({
      path,
      code: 'SCHEMA_VIOLATION',
      message: `${field}: ${issue.message}`,
    })
  }
}

function renderFieldPath(path: readonly PropertyKey[]): string {
  let rendered = ''
  for (const segment of path) {
    if (typeof segment === 'number') {
      rendered += `[${segment}]`
    } else if (rendered === '') {
      rendered = String(segment)
    } else {
      rendered += `.${String(segment)}`
    }
  }
  return rendered === '' ? '<root>' : rendered
}

function registerId(
  ids: Map<string, { id: string; scope: string; paths: string[] }>,
  key: string,
  id: string,
  scope: string,
  path: string,
): void {
  const existing = ids.get(key)
  if (existing === undefined) {
    ids.set(key, { id, scope, paths: [path] })
  } else {
    existing.paths.push(path)
  }
}

function taskLinkKey(lang: Lang, version: string, locale: string, taskId: string): string {
  return `${lang}\u0000${version}\u0000${locale}\u0000${taskId}`
}

function registerTaskForGolden(
  tasks: Map<string, { split: Split; path: string }[]>,
  location: TaskLocation,
  entry: TaskEntry,
  path: string,
): void {
  const key = taskLinkKey(entry.lang, location.version, entry.locale ?? entry.lang, entry.id)
  const records = tasks.get(key)
  if (records === undefined) {
    tasks.set(key, [{ split: entry.split, path }])
  } else {
    records.push({ split: entry.split, path })
  }
}

/** A golden link must resolve to a task in the same language/version/locale and split. */
function checkGoldenTaskLink(
  entry: GoldenEntry,
  location: GoldenLocation,
  path: string,
  tasks: Map<string, { split: Split; path: string }[]>,
  violations: TaskViolation[],
): void {
  if (entry.locale !== undefined && baseLanguageOfLocale(entry.locale) !== location.lang) {
    violations.push({
      path,
      code: 'GOLDEN_LOCALE_MISMATCH',
      message: `entry locale "${entry.locale}" does not match path language "${location.lang}"`,
    })
  }

  if (entry.taskId === undefined) return

  const locale = entry.locale ?? location.lang
  const records = tasks.get(taskLinkKey(location.lang, location.version, locale, entry.taskId))
  if (records === undefined || records.length === 0) {
    violations.push({
      path,
      code: 'GOLDEN_TASK_MISSING',
      message: `taskId "${entry.taskId}" does not resolve to a task with lang "${location.lang}", locale "${locale}" and version "${location.version}"`,
    })
    return
  }

  if (!records.some((record) => record.split === entry.split)) {
    const splits = [...new Set(records.map((record) => record.split))].join(', ')
    violations.push({
      path,
      code: 'GOLDEN_TASK_SPLIT_MISMATCH',
      message: `golden entry split "${entry.split}" does not match task "${entry.taskId}" split (${splits})`,
    })
  }
}

function checkSessionReferences(entry: TaskEntry, path: string, violations: TaskViolation[]): void {
  const session = entry.session
  if (entry.mode !== 'session' || session === undefined) return

  const locale = entry.locale ?? entry.lang
  const persona = PERSONAS_BY_ID.get(session.personaId)
  if (persona === undefined) {
    violations.push({
      path,
      code: 'SESSION_REFERENCE_MISSING',
      message: `personaId "${session.personaId}" does not resolve to a registered persona`,
    })
  } else {
    if (persona.version !== session.personaVersion) {
      violations.push({
        path,
        code: 'SESSION_VERSION_MISMATCH',
        message: `persona "${persona.id}" is version "${persona.version}", not "${session.personaVersion}"`,
      })
    }
    try {
      personaVariant(persona, locale)
    } catch {
      violations.push({
        path,
        code: 'SESSION_LOCALE_MISSING',
        message: `persona "${persona.id}" has no variant for locale "${locale}"`,
      })
    }
  }

  const scenario = SCENARIOS_BY_ID.get(session.scenarioId)
  if (scenario === undefined) {
    violations.push({
      path,
      code: 'SESSION_REFERENCE_MISSING',
      message: `scenarioId "${session.scenarioId}" does not resolve to a registered scenario`,
    })
    return
  }

  if (scenario.version !== session.scenarioVersion) {
    violations.push({
      path,
      code: 'SESSION_VERSION_MISMATCH',
      message: `scenario "${scenario.id}" is version "${scenario.version}", not "${session.scenarioVersion}"`,
    })
  }

  let variant: ScenarioVariant
  try {
    variant = scenarioVariant(scenario, locale)
  } catch {
    violations.push({
      path,
      code: 'SESSION_LOCALE_MISSING',
      message: `scenario "${scenario.id}" has no variant for locale "${locale}"`,
    })
    return
  }

  if (!variant.personaIds.includes(session.personaId)) {
    violations.push({
      path,
      code: 'SESSION_PERSONA_MISMATCH',
      message: `scenario "${scenario.id}" does not include persona "${session.personaId}"`,
    })
  }
}

function registerSpeaker(
  speakers: Map<string, Map<string, { path: string; split: Split }[]>>,
  scope: string,
  speakerId: string,
  path: string,
  split: Split,
): void {
  let bySpeaker = speakers.get(scope)
  if (bySpeaker === undefined) {
    bySpeaker = new Map()
    speakers.set(scope, bySpeaker)
  }
  const records = bySpeaker.get(speakerId)
  if (records === undefined) {
    bySpeaker.set(speakerId, [{ path, split }])
  } else {
    records.push({ path, split })
  }
}

function parseTaskLocation(pathInEvals: string): TaskLocation | undefined {
  const [kind, dataset, version, lang, ...rest] = pathInEvals.split('/')
  if (kind !== 'tasks') return undefined
  if (dataset === undefined || dataset === '') return undefined
  if (version === undefined || version === '') return undefined
  if (lang === undefined || !isLang(lang)) return undefined
  if (rest.length === 0) return undefined
  return { dataset, version, lang, scope: `${dataset}/${version}/${lang}` }
}

function parseGoldenLocation(pathInEvals: string): GoldenLocation | undefined {
  const [kind, lang, version, ...rest] = pathInEvals.split('/')
  if (kind !== 'golden') return undefined
  if (lang === undefined || !isLang(lang)) return undefined
  if (version === undefined || version === '') return undefined
  if (rest.length === 0) return undefined
  return { version, lang, scope: `${lang}/${version}` }
}

/** `evals/tasks/...` -> `tasks/...`; layout parsing is relative to `evals/`. */
function relativeToEvals(displayPath: string): string {
  return displayPath.split('/').slice(1).join('/')
}

function isLang(value: string): value is Lang {
  return (LANGS as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
