import { mkdtemp, readdir, readFile } from 'node:fs/promises'
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
