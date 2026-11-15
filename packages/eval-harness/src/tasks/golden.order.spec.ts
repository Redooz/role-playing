import type { Dirent } from 'node:fs'
import type * as fsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadGoldenEntries } from './golden.js'

/**
 * Ordering contract for `collectJsonFiles`.
 *
 * POSIX does not promise a `readdir` order. This file mocks `readdir` so every
 * directory is returned in reverse lexical order, which is the only way to show
 * that `loadGoldenEntries` sorts children itself instead of inheriting whatever
 * the filesystem hands back. `readFile` and the rest of `node:fs/promises` stay
 * real; the mock lives in its own spec file so it cannot affect `golden.spec.ts`.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>()

  const readdirMock = async (...args: unknown[]): Promise<unknown> => {
    const read = actual.readdir as unknown as (...parameters: unknown[]) => Promise<unknown>
    const entries = (await read(...args)) as readonly (string | Dirent)[]
    const nameOf = (entry: string | Dirent): string =>
      typeof entry === 'string' ? entry : entry.name

    return [...entries]
      .sort((left, right) => {
        const a = nameOf(left)
        const b = nameOf(right)
        return a < b ? -1 : a > b ? 1 : 0
      })
      .reverse()
      .map((entry) =>
        typeof entry === 'string'
          ? entry
          : {
              name: entry.name,
              isDirectory: () => entry.isDirectory(),
              isFile: () => entry.isFile(),
            },
      )
  }

  return { ...actual, readdir: readdirMock as unknown as typeof actual.readdir }
})

function goldenJson(id: string, taskId: string, lang = 'en'): string {
  return JSON.stringify({
    id,
    lang,
    split: 'calibration',
    taskId,
    routingLabels: { intent: 'request-deadline-extension', expectedPersonaId: 'manager' },
    dimensionScores: { clarity: { score: 4 } },
    evidenceSpans: [],
    pairwisePreferences: [],
    status: 'draft',
  })
}

/** Writes the files in reverse lexical creation order to prove creation order is irrelevant. */
async function makeGoldenTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rp-golden-order-'))
  const directory = join(root, 'evals/golden/en/v1')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'zz.json'), goldenJson('dup', 't-zz'), 'utf8')
  await writeFile(join(directory, 'mm.json'), goldenJson('dup', 't-mm'), 'utf8')
  await writeFile(join(directory, 'aa.json'), goldenJson('dup', 't-aa'), 'utf8')
  return root
}

describe('loadGoldenEntries with an unsorted readdir', () => {
  it('sorts equal-key entries by file path even when readdir is reversed', async () => {
    const root = await makeGoldenTree()
    try {
      const entries = await loadGoldenEntries(root, { version: 'v1', languages: ['en'] })

      expect(entries.map((item) => item.taskId)).toStrictEqual(['t-aa', 't-mm', 't-zz'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still sorts by language and id after the child order is normalised', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-golden-order-'))
    try {
      const englishDir = join(root, 'evals/golden/en/v1')
      const frenchDir = join(root, 'evals/golden/fr/v1')
      await mkdir(englishDir, { recursive: true })
      await mkdir(frenchDir, { recursive: true })
      await writeFile(join(englishDir, 'zz.json'), goldenJson('zz', 'en-zz'), 'utf8')
      await writeFile(join(englishDir, 'aa.json'), goldenJson('aa', 'en-aa'), 'utf8')
      await writeFile(join(frenchDir, 'zz.json'), goldenJson('zz', 'fr-zz', 'fr'), 'utf8')
      await writeFile(join(frenchDir, 'aa.json'), goldenJson('aa', 'fr-aa', 'fr'), 'utf8')

      const entries = await loadGoldenEntries(root, { version: 'v1', languages: ['fr', 'en'] })

      expect(entries.map((item) => `${item.lang}:${item.taskId}`)).toStrictEqual([
        'en:en-aa',
        'en:en-zz',
        'fr:fr-aa',
        'fr:fr-zz',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
