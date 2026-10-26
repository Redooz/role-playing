import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskEntry, GoldenEntry } from './schema.js'
import { validateTaskTree } from './validate.js'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Writes the given `relative path -> JSON value` map into a fresh temp tree. */
async function makeTree(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rp-eval-tree-'))
  tempDirs.push(root)
  for (const [relativePath, value] of Object.entries(files)) {
    const target = join(root, relativePath)
    await mkdir(dirname(target), { recursive: true })
    const contents = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    await writeFile(target, contents, 'utf8')
  }
  return root
}

function taskPath(
  lang: 'en' | 'fr',
  name: string,
  dataset = 'synthetic-workplace',
  version = 'v1',
): string {
  return `evals/tasks/${dataset}/${version}/${lang}/${name}.json`
}

function goldenPath(lang: 'en' | 'fr', name: string): string {
  return `evals/golden/${lang}/v1/${name}.json`
}

function taskEntry(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: 'task-001',
    lang: 'en',
    domain: 'workplace',
    scenarioType: 'request-deadline-extension',
    cefrBand: 'B1',
    speakerId: 'speaker-001',
    split: 'calibration',
    provenance: { source: 'synthetic' },
    consentScope: 'synthetic-no-consent-required',
    annotationVersions: { rubric: 'v1' },
    content: {
      scenarioBrief: 'A learner asks a manager for more time.',
      turns: [
        { role: 'persona', text: 'How is it going?' },
        { role: 'user', text: 'Could I have two more days?' },
      ],
    },
    ...overrides,
  }
}

function goldenEntry(overrides: Partial<GoldenEntry> = {}): GoldenEntry {
  return {
    id: 'golden-001',
    lang: 'en',
    split: 'calibration',
    routingLabels: { intent: 'request-deadline-extension', expectedPersonaId: 'persona-manager' },
    dimensionScores: { clarity: { score: 4 } },
    evidenceSpans: [{ turnIndex: 1, textRef: 'two more days' }],
    pairwisePreferences: [],
    status: 'draft',
    ...overrides,
  }
}

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

  it('flags a task without provenance', async () => {
    const { provenance: _provenance, ...withoutProvenance } = taskEntry()
    const root = await makeTree({
      [taskPath('en', 'no-provenance')]: withoutProvenance,
    })

    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toContain('MISSING_PROVENANCE')
    expect(violations[0]?.path).toBe(taskPath('en', 'no-provenance'))
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

  it('rejects a stable golden entry without measured agreement', async () => {
    const root = await makeTree({
      [goldenPath('en', 'stable')]: goldenEntry({ status: 'stable' }),
    })

    const violations = await validateTaskTree(root)
    expect(violations).toEqual([
      {
        path: goldenPath('en', 'stable'),
        code: 'GOLDEN_AGREEMENT_MISSING',
        message: expect.stringContaining('annotatorAgreement'),
      },
    ])
  })

  it('rejects a stable golden entry with only one annotator', async () => {
    const root = await makeTree({
      [goldenPath('en', 'stable')]: goldenEntry({
        status: 'stable',
        annotatorAgreement: { annotators: ['annotator-a'], metric: 'cohen_kappa', value: 0.8 },
      }),
    })

    const violations = await validateTaskTree(root)
    expect(violations.map((violation) => violation.code)).toEqual(['GOLDEN_AGREEMENT_MISSING'])
  })

  it('accepts a stable golden entry with measured agreement', async () => {
    const root = await makeTree({
      [goldenPath('en', 'stable')]: goldenEntry({
        status: 'stable',
        annotatorAgreement: {
          annotators: ['annotator-a', 'annotator-b'],
          metric: 'cohen_kappa',
          value: 0.71,
        },
      }),
    })

    expect(await validateTaskTree(root)).toEqual([])
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
    tempDirs.push(root)

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
