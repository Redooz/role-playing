import type { Dirent } from 'node:fs'
import type * as fsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { validateTaskTree } from './validate.js'

/**
 * Ordering contract for the task walker.
 *
 * `validateTaskTree` promises violations in a deterministic order, and the
 * duplicate rule names the lexicographically first path as the owner. That
 * attribution depends on the walker sorting the collected files, not on
 * `readdir`. This file mocks `readdir` to return every directory in reverse
 * lexical order, so dropping the sort changes the reported owner. `readFile`
 * and `stat` stay real, and the mock lives in its own spec file.
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

function taskJson(id: string, speakerId: string): string {
  return JSON.stringify({
    id,
    lang: 'en',
    mode: 'replay',
    domain: 'workplace',
    scenarioType: 'request-deadline-extension',
    cefrBand: 'B1',
    speakerId,
    split: 'calibration',
    provenance: { source: 'synthetic' },
    consentScope: 'synthetic-no-consent-required',
    annotationVersions: { rubric: 'v1' },
    content: {
      scenarioBrief: 'A learner asks a manager for more time.',
      turns: [{ role: 'user', text: 'Could I have two more days?' }],
    },
  })
}

describe('validateTaskTree with an unsorted readdir', () => {
  it('names the lexicographically first path as the duplicate owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-eval-order-'))
    try {
      const languageDir = join(root, 'evals/tasks/synthetic-workplace/v1/en')
      // `a.json` sorts before `a/x.json` by full path, even though `a` sorts
      // before `a.json` by directory entry name.
      await mkdir(join(languageDir, 'a'), { recursive: true })
      await writeFile(join(languageDir, 'a/x.json'), taskJson('dup', 'speaker-002'), 'utf8')
      await writeFile(join(languageDir, 'a.json'), taskJson('dup', 'speaker-001'), 'utf8')

      const violations = await validateTaskTree(root)

      expect(violations).toStrictEqual([
        {
          path: 'evals/tasks/synthetic-workplace/v1/en/a/x.json',
          code: 'DUPLICATE_ID',
          message:
            'id "dup" is already used by evals/tasks/synthetic-workplace/v1/en/a.json within synthetic-workplace/v1/en/en',
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('names the first task path independent of readdir order in a flat directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-eval-order-'))
    try {
      const languageDir = join(root, 'evals/tasks/synthetic-workplace/v1/en')
      await mkdir(languageDir, { recursive: true })
      // Creation order is the reverse of lexical order.
      await writeFile(join(languageDir, 'zz.json'), taskJson('dup', 'speaker-002'), 'utf8')
      await writeFile(join(languageDir, 'aa.json'), taskJson('dup', 'speaker-001'), 'utf8')

      const violations = await validateTaskTree(root)

      expect(violations).toStrictEqual([
        {
          path: 'evals/tasks/synthetic-workplace/v1/en/zz.json',
          code: 'DUPLICATE_ID',
          message:
            'id "dup" is already used by evals/tasks/synthetic-workplace/v1/en/aa.json within synthetic-workplace/v1/en/en',
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
