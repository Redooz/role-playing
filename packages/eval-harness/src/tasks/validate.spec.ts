import { chmod, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { GoldenEntry, TaskEntry } from './schema.js'
import { validateTaskTree } from './validate.js'
import {
  cleanupTempDirs,
  goldenEntry,
  goldenPath,
  makeTree,
  routingGolden,
  routingTask,
  taskEntry,
  taskPath,
} from './task-tree.fixtures.js'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

afterEach(cleanupTempDirs)

describe('validateTaskTree', () => {
  it('passes a valid English/French tree', async () => {
    const root = await makeTree({
      [taskPath('en', 'cal')]: taskEntry({ id: 'en-1', speakerId: 'en-speaker-cal' }),
      [taskPath('en', 'hold')]: taskEntry({
        id: 'en-2',
        speakerId: 'en-speaker-hold',
        split: 'holdout',
      }),
      [taskPath('fr', 'cal')]: taskEntry({
        id: 'fr-1',
        lang: 'fr',
        speakerId: 'fr-speaker-cal',
      }),
      [goldenPath('en', 'g')]: goldenEntry(),
      [goldenPath('fr', 'g')]: goldenEntry({ id: 'golden-fr-001', lang: 'fr' }),
    })

    expect(await validateTaskTree(root)).toEqual([])
  })

  it('detects a speaker that leaks across calibration and holdout', async () => {
    const root = await makeTree({
      [taskPath('en', 'cal')]: taskEntry({
        id: 'en-1',
        speakerId: 'shared-speaker',
        split: 'calibration',
      }),
      [taskPath('en', 'hold')]: taskEntry({
        id: 'en-2',
        speakerId: 'shared-speaker',
        split: 'holdout',
      }),
    })

    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toEqual([
      'SPLIT_LEAKAGE',
      'SPLIT_LEAKAGE',
    ])
    expect(violations.map((violation) => violation.path)).toEqual([
      taskPath('en', 'cal'),
      taskPath('en', 'hold'),
    ])
  })

  it('scopes the split rule per dataset, version, and language', async () => {
    const root = await makeTree({
      [taskPath('en', 'cal')]: taskEntry({
        id: 'en-1',
        speakerId: 'shared-speaker',
        split: 'calibration',
      }),
      [taskPath('fr', 'hold')]: taskEntry({
        id: 'fr-1',
        lang: 'fr',
        speakerId: 'shared-speaker',
        split: 'holdout',
      }),
      [taskPath('en', 'other-dataset-hold', 'other-workplace')]: taskEntry({
        id: 'other-1',
        speakerId: 'shared-speaker',
        split: 'holdout',
      }),
      [taskPath('en', 'v2-hold', 'synthetic-workplace', 'v2')]: taskEntry({
        id: 'v2-1',
        speakerId: 'shared-speaker',
        split: 'holdout',
      }),
    })

    expect(await validateTaskTree(root)).toEqual([])
  })

  it('flags a path/entry language mismatch', async () => {
    const root = await makeTree({
      [taskPath('en', 'wrong-lang')]: taskEntry({ lang: 'fr' }),
    })

    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toContain('LANG_PATH_MISMATCH')
  })

  it('flags duplicate ids inside one dataset/version/language scope', async () => {
    const root = await makeTree({
      [taskPath('en', 'first')]: taskEntry({ id: 'duplicate-id' }),
      [taskPath('en', 'second')]: taskEntry({ id: 'duplicate-id', speakerId: 'speaker-002' }),
      [taskPath('fr', 'third')]: taskEntry({ id: 'duplicate-id', lang: 'fr' }),
    })

    const violations = await validateTaskTree(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      path: taskPath('en', 'second'),
      code: 'DUPLICATE_ID',
    })
  })

  it('reports schema violations with the failing field', async () => {
    const root = await makeTree({
      [taskPath('en', 'bad-cefr')]: { ...taskEntry(), cefrBand: 'D1' },
    })

    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toEqual(['SCHEMA_VIOLATION'])
    expect(violations[0]?.path).toBe(taskPath('en', 'bad-cefr'))
    expect(violations[0]?.message).toContain('cefrBand')
  })

  it('reports files outside the layout contract', async () => {
    const root = await makeTree({
      'evals/tasks/stray.json': taskEntry(),
    })

    const violations = await validateTaskTree(root)
    expect(violations).toEqual([
      {
        path: 'evals/tasks/stray.json',
        code: 'INVALID_LAYOUT',
        message: expect.stringContaining('evals/tasks/<dataset>/<version>/<lang>'),
      },
    ])
  })

  it('reports invalid JSON without throwing', async () => {
    const root = await makeTree({
      [taskPath('en', 'broken')]: '{ "id": ',
    })

    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toEqual(['INVALID_JSON'])
  })

  it('reports a missing evals directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-eval-tree-'))

    const violations = await validateTaskTree(root)
    expect(violations).toEqual([
      {
        path: 'evals',
        code: 'EVALS_DIR_MISSING',
        message: expect.stringContaining(root),
      },
    ])
  })

  it('passes the committed evals tree (gate G3)', async () => {
    expect(await validateTaskTree(REPO_ROOT)).toEqual([])
  })
})

describe('seeded task tree', () => {
  it('ships three synthetic tasks per language and one draft golden entry', async () => {
    for (const lang of ['en', 'fr'] as const) {
      const taskDir = join(REPO_ROOT, 'evals/tasks/synthetic-workplace/v1', lang)
      const taskFiles = (await readdir(taskDir)).filter((name) => name.endsWith('.json')).sort()
      expect(taskFiles).toHaveLength(3)

      const entries: TaskEntry[] = []
      for (const fileName of taskFiles) {
        entries.push(JSON.parse(await readFile(join(taskDir, fileName), 'utf8')) as TaskEntry)
      }

      expect(entries.filter((entry) => entry.split === 'calibration')).toHaveLength(2)
      expect(entries.filter((entry) => entry.split === 'holdout')).toHaveLength(1)
      expect(new Set(entries.map((entry) => entry.speakerId)).size).toBe(3)
      for (const entry of entries) {
        expect(entry.lang).toBe(lang)
        expect(entry.provenance.source).toBe('synthetic')
        expect(entry.consentScope).toBe('synthetic-no-consent-required')
      }

      const goldenDir = join(REPO_ROOT, 'evals/golden', lang, 'v1')
      const goldenFiles = (await readdir(goldenDir)).filter((name) => name.endsWith('.json'))
      expect(goldenFiles).toHaveLength(1)

      const [goldenFile] = goldenFiles
      if (goldenFile === undefined) continue
      const golden = JSON.parse(await readFile(join(goldenDir, goldenFile), 'utf8')) as GoldenEntry
      expect(golden.status).toBe('draft')
      expect(golden.annotatorAgreement).toBeUndefined()
    }
  })
})

describe('directory walker', () => {
  it('treats a missing evals/tasks or evals/golden subtree as empty', async () => {
    const root = await makeTree({ 'evals/README.md': '# evals' })

    expect(await validateTaskTree(root)).toStrictEqual([])
  })

  it('reports a missing evals directory with the resolved root in the message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-eval-tree-'))
    try {
      expect(await validateTaskTree(`${root}/.`)).toStrictEqual([
        {
          path: 'evals',
          code: 'EVALS_DIR_MISSING',
          message: `expected an evals/ directory under ${root}`,
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats evals that is a plain file as missing', async () => {
    const root = await makeTree({ evals: 'not a directory' })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: 'evals',
        code: 'EVALS_DIR_MISSING',
        message: `expected an evals/ directory under ${root}`,
      },
    ])
  })

  it('treats a dangling evals symlink as missing instead of throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-eval-tree-'))
    try {
      await symlink(join(root, 'missing-target'), join(root, 'evals'))
      expect(await validateTaskTree(root)).toStrictEqual([
        {
          path: 'evals',
          code: 'EVALS_DIR_MISSING',
          message: `expected an evals/ directory under ${root}`,
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('walks nested directories and ignores files that are not lowercase .json', async () => {
    const root = await makeTree({
      [taskPath('en', 'nested/inside')]: taskEntry(),
      'evals/tasks/synthetic-workplace/v1/en/notes.md': 'not a task',
      'evals/tasks/synthetic-workplace/v1/en/UPPER.JSON': '{ not json',
    })

    expect(await validateTaskTree(root)).toStrictEqual([])
  })

  it('does not follow symlinked directories or symlinked json files', async () => {
    const root = await makeTree({
      [taskPath('en', 'real')]: taskEntry(),
      'outside/bad.json': '{ "id": ',
    })
    const languageDir = join(root, 'evals/tasks/synthetic-workplace/v1/en')
    await symlink(join(root, 'outside'), join(languageDir, 'linked-dir'))
    await symlink(join(root, 'outside/bad.json'), join(languageDir, 'linked.json'))

    expect(await validateTaskTree(root)).toStrictEqual([])
  })

  it('reports an unreadable tasks directory instead of throwing', async () => {
    const root = await makeTree({ 'evals/tasks': 'not a directory' })
    const expected = await captureError(readdir(join(root, 'evals/tasks'), { withFileTypes: true }))

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: 'evals/tasks',
        code: 'UNREADABLE_DIRECTORY',
        message: `cannot read directory: ${expected.message}`,
      },
    ])
  })

  it.skipIf(process.getuid?.() === 0)(
    'reports an unreadable file instead of throwing',
    async () => {
      const path = taskPath('en', 'locked')
      const root = await makeTree({ [path]: taskEntry() })
      const file = join(root, path)
      await chmod(file, 0o000)

      const expected = await captureError(readFile(file, 'utf8'))
      expect(await validateTaskTree(root)).toStrictEqual([
        {
          path,
          code: 'UNREADABLE_FILE',
          message: `cannot read file: ${expected.message}`,
        },
      ])
    },
  )

  it.skipIf(process.getuid?.() === 0)('reports an unreadable subdirectory', async () => {
    const root = await makeTree({ [taskPath('en', 'locked/task')]: taskEntry() })
    const locked = join(root, 'evals/tasks/synthetic-workplace/v1/en/locked')
    await chmod(locked, 0o000)

    try {
      const expected = await captureError(readdir(locked, { withFileTypes: true }))
      expect(await validateTaskTree(root)).toStrictEqual([
        {
          path: 'evals/tasks/synthetic-workplace/v1/en/locked',
          code: 'UNREADABLE_DIRECTORY',
          message: `cannot read directory: ${expected.message}`,
        },
      ])
    } finally {
      await chmod(locked, 0o755)
    }
  })

  it('reports invalid JSON with the parser message', async () => {
    const root = await makeTree({ [taskPath('en', 'broken')]: '{ "id": ' })
    const expected = await captureError(Promise.resolve().then(() => JSON.parse('{ "id": ')))

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: taskPath('en', 'broken'),
        code: 'INVALID_JSON',
        message: `invalid JSON: ${expected.message}`,
      },
    ])
  })
})

describe('schema violation rendering', () => {
  it('uses the <root> placeholder for an entry that is not an object', async () => {
    const path = taskPath('en', 'null-entry')
    const root = await makeTree({ [path]: 'null' })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path,
        code: 'SCHEMA_VIOLATION',
        message: '<root>: Invalid input: expected object, received null',
      },
    ])
  })

  it('orders metadata and schema violations by code, then by message', async () => {
    const path = taskPath('en', 'missing-metadata')
    const { provenance: _provenance, consentScope: _consentScope, ...withoutMetadata } = taskEntry()
    const root = await makeTree({ [path]: withoutMetadata })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path,
        code: 'MISSING_CONSENT_SCOPE',
        message: 'consentScope must be a non-empty string',
      },
      {
        path,
        code: 'MISSING_PROVENANCE',
        message: 'provenance is required (M0 default: { "source": "synthetic" })',
      },
      {
        path,
        code: 'SCHEMA_VIOLATION',
        message: 'consentScope: Invalid input: expected string, received undefined',
      },
      {
        path,
        code: 'SCHEMA_VIOLATION',
        message: 'provenance: Invalid input: expected object, received undefined',
      },
    ])
  })

  it('sorts schema issues for one file by their rendered message', async () => {
    const path = taskPath('en', 'two-issues')
    const root = await makeTree({
      [path]: { ...taskEntry(), cefrBand: 'D1', annotationVersions: [] },
    })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path,
        code: 'MISSING_ANNOTATION_VERSIONS',
        message: 'annotationVersions must be a non-empty record of name → version',
      },
      {
        path,
        code: 'SCHEMA_VIOLATION',
        message: 'annotationVersions: Invalid input: expected record, received array',
      },
      {
        path,
        code: 'SCHEMA_VIOLATION',
        message: 'cefrBand: Invalid option: expected one of "A1"|"A2"|"B1"|"B2"|"C1"|"C2"',
      },
    ])
  })

  it('keeps the non-agreement schema issue when suppressing the duplicate agreement issue', async () => {
    const path = goldenPath('en', 'stable-without-agreement')
    const root = await makeTree({
      [path]: goldenEntry({
        status: 'stable',
        dimensionScores: undefined,
        annotatorAgreement: undefined,
      }),
    })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path,
        code: 'GOLDEN_AGREEMENT_MISSING',
        message:
          "status 'stable' requires annotatorAgreement measured with at least 2 distinct annotators, a metric, and a value",
      },
      {
        path,
        code: 'SCHEMA_VIOLATION',
        message: 'dimensionScores: a legacy routingLabels entry requires dimensionScores',
      },
    ])
  })
})

describe('language and layout messages', () => {
  it('reports a task whose entry language differs from its path', async () => {
    const path = taskPath('en', 'wrong-lang')
    const root = await makeTree({ [path]: taskEntry({ lang: 'fr' }) })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path,
        code: 'LANG_PATH_MISMATCH',
        message: 'entry lang is "fr" but the path says "en"',
      },
    ])
  })

  it('reports a golden entry whose language differs from its path', async () => {
    const path = goldenPath('en', 'wrong-lang')
    const root = await makeTree({ [path]: goldenEntry({ lang: 'fr' }) })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path,
        code: 'LANG_PATH_MISMATCH',
        message: 'entry lang is "fr" but the path says "en"',
      },
    ])
  })

  it('reports a golden entry outside the layout contract', async () => {
    const root = await makeTree({ 'evals/golden/stray.json': goldenEntry() })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: 'evals/golden/stray.json',
        code: 'INVALID_LAYOUT',
        message:
          'golden files must live at evals/golden/<lang>/<version>/**.json with lang in en|fr',
      },
    ])
  })

  it('rejects a language segment that is not en or fr', async () => {
    const path = 'evals/tasks/synthetic-workplace/v1/en-UK/task.json'
    const root = await makeTree({ [path]: taskEntry() })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path,
        code: 'INVALID_LAYOUT',
        message:
          'task files must live at evals/tasks/<dataset>/<version>/<lang>/**.json with lang in en|fr',
      },
    ])
  })

  it('reports a golden entry whose locale does not match the path language', async () => {
    const path = goldenPath('en', 'locale-mismatch')
    const root = await makeTree({ [path]: goldenEntry({ locale: 'fr-CA' }) })

    expect(await validateTaskTree(root)).toContainEqual({
      path,
      code: 'GOLDEN_LOCALE_MISMATCH',
      message: 'entry locale "fr-CA" does not match path language "en"',
    })
  })
})

describe('duplicate id scoping', () => {
  it('treats an explicit base-language locale and no locale as the same namespace', async () => {
    const root = await makeTree({
      [taskPath('en', 'a')]: taskEntry({ id: 'dup', locale: 'en' }),
      [taskPath('en', 'b')]: taskEntry({ id: 'dup', speakerId: 'speaker-002' }),
    })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: taskPath('en', 'b'),
        code: 'DUPLICATE_ID',
        message: `id "dup" is already used by ${taskPath('en', 'a')} within synthetic-workplace/v1/en/en`,
      },
    ])
  })

  it('scopes a regional locale to its own namespace', async () => {
    const root = await makeTree({
      [taskPath('en', 'a')]: taskEntry({ id: 'dup', locale: 'en-GB' }),
      [taskPath('en', 'b')]: taskEntry({ id: 'dup', locale: 'en-GB', speakerId: 'speaker-002' }),
    })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: taskPath('en', 'b'),
        code: 'DUPLICATE_ID',
        message: `id "dup" is already used by ${taskPath('en', 'a')} within synthetic-workplace/v1/en/en-GB`,
      },
    ])
  })

  it('does not treat the same id as a duplicate across locales', async () => {
    const root = await makeTree({
      [taskPath('en', 'a')]: taskEntry({ id: 'dup', locale: 'en' }),
      [taskPath('en', 'b')]: taskEntry({ id: 'dup', locale: 'en-GB', speakerId: 'speaker-002' }),
    })

    expect(await validateTaskTree(root)).toStrictEqual([])
  })

  it('names the lexicographically first path as the original', async () => {
    const root = await makeTree({
      [taskPath('en', 'b')]: taskEntry({ id: 'dup' }),
      [taskPath('en', 'a')]: taskEntry({ id: 'dup', speakerId: 'speaker-002' }),
    })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: taskPath('en', 'b'),
        code: 'DUPLICATE_ID',
        message: `id "dup" is already used by ${taskPath('en', 'a')} within synthetic-workplace/v1/en/en`,
      },
    ])
  })
})

describe('routing label registration', () => {
  it('matches a routing label through the task locale', async () => {
    const root = await makeTree({
      [taskPath('en', 'routing')]: routingTask({ locale: 'en-GB' }),
      [goldenPath('en', 'routing')]: routingGolden({ locale: 'en-GB' }),
    })

    expect(await validateTaskTree(root)).toStrictEqual([])
  })

  it('does not match a base-locale label to a regional-locale task', async () => {
    const root = await makeTree({
      [taskPath('en', 'routing')]: routingTask({ locale: 'en-GB' }),
      [goldenPath('en', 'routing')]: routingGolden(),
    })

    const violations = await validateTaskTree(root)
    expect(violations).toContainEqual({
      path: taskPath('en', 'routing'),
      code: 'ROUTING_LABEL_MISSING',
      message: 'a routing task requires a routingOutcome golden label in its split',
    })
    expect(violations).toContainEqual({
      path: goldenPath('en', 'routing'),
      code: 'GOLDEN_TASK_MISSING',
      message:
        'taskId "routing-001" does not resolve to a task with lang "en", locale "en" and version "v1"',
    })
  })

  it('requires a routing label to name its task before registration', async () => {
    const root = await makeTree({
      [taskPath('en', 'routing')]: routingTask(),
      [goldenPath('en', 'routing')]: routingGolden({ taskId: undefined }),
    })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: goldenPath('en', 'routing'),
        code: 'ROUTING_LABEL_INVALID',
        message: 'a routingOutcome label must name the routing taskId it labels',
      },
      {
        path: taskPath('en', 'routing'),
        code: 'ROUTING_LABEL_MISSING',
        message: 'a routing task requires a routingOutcome golden label in its split',
      },
    ])
  })

  it('does not match a label registered under another version', async () => {
    const root = await makeTree({
      [taskPath('en', 'routing')]: routingTask(),
      'evals/golden/en/v2/routing.json': routingGolden(),
    })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: 'evals/golden/en/v2/routing.json',
        code: 'GOLDEN_TASK_MISSING',
        message:
          'taskId "routing-001" does not resolve to a task with lang "en", locale "en" and version "v2"',
      },
      {
        path: taskPath('en', 'routing'),
        code: 'ROUTING_LABEL_MISSING',
        message: 'a routing task requires a routingOutcome golden label in its split',
      },
    ])
  })
})

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected the operation to fail')
}

describe('golden file failures', () => {
  it('reports invalid JSON in a golden file once', async () => {
    const path = goldenPath('en', 'broken')
    const root = await makeTree({ [path]: '{ "id": ' })
    const expected = await captureError(Promise.resolve().then(() => JSON.parse('{ "id": ')))

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path,
        code: 'INVALID_JSON',
        message: `invalid JSON: ${expected.message}`,
      },
    ])
  })

  it('treats an explicit base-language golden locale and no locale as the same namespace', async () => {
    const root = await makeTree({
      [goldenPath('en', 'a')]: goldenEntry({ id: 'dup', locale: 'en' }),
      [goldenPath('en', 'b')]: goldenEntry({ id: 'dup' }),
    })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: goldenPath('en', 'b'),
        code: 'DUPLICATE_ID',
        message: `id "dup" is already used by ${goldenPath('en', 'a')} within en/v1/en`,
      },
    ])
  })

  it('scopes a regional golden locale to its own namespace', async () => {
    const root = await makeTree({
      [goldenPath('en', 'a')]: goldenEntry({ id: 'dup', locale: 'en-GB' }),
      [goldenPath('en', 'b')]: goldenEntry({ id: 'dup', locale: 'en-GB' }),
    })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: goldenPath('en', 'b'),
        code: 'DUPLICATE_ID',
        message: `id "dup" is already used by ${goldenPath('en', 'a')} within en/v1/en-GB`,
      },
    ])
  })

  it('does not treat the same golden id as a duplicate across locales', async () => {
    const root = await makeTree({
      [goldenPath('en', 'a')]: goldenEntry({ id: 'dup', locale: 'en' }),
      [goldenPath('en', 'b')]: goldenEntry({ id: 'dup', locale: 'en-GB' }),
    })

    expect(await validateTaskTree(root)).toStrictEqual([])
  })
})

describe('routing label registration guard', () => {
  it('does not accept a legacy-labelled golden as a routing outcome label', async () => {
    const root = await makeTree({
      [taskPath('en', 'routing')]: routingTask(),
      [goldenPath('en', 'legacy')]: goldenEntry({ taskId: 'routing-001' }),
    })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: taskPath('en', 'routing'),
        code: 'ROUTING_LABEL_MISSING',
        message: 'a routing task requires a routingOutcome golden label in its split',
      },
    ])
  })
})
