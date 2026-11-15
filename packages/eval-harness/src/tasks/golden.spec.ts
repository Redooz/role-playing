import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { goldenIndexByTask, loadGoldenEntries } from './golden.js'
import { cleanupTempDirs, goldenEntry, makeTree } from './task-tree.fixtures.js'
import type { GoldenEntry } from './schema.js'

afterEach(cleanupTempDirs)

function entry(overrides: Partial<GoldenEntry> = {}): GoldenEntry {
  return goldenEntry(overrides)
}

describe('loadGoldenEntries', () => {
  it('loads the entries for one language and version', async () => {
    const root = await makeTree({
      'evals/golden/en/v1/a.json': entry({ id: 'golden-a' }),
      'evals/golden/en/v1/b.json': entry({ id: 'golden-b' }),
      'evals/golden/en/v2/ignored.json': entry({ id: 'golden-v2' }),
      'evals/golden/fr/v1/ignored.json': entry({ id: 'golden-fr', lang: 'fr' }),
    })

    const entries = await loadGoldenEntries(root, { version: 'v1', languages: ['en'] })

    expect(entries.map((item) => item.id)).toStrictEqual(['golden-a', 'golden-b'])
  })

  it('sorts by language and then id, independent of the requested language order', async () => {
    const root = await makeTree({
      'evals/golden/fr/v1/b.json': entry({ id: 'b', lang: 'fr' }),
      'evals/golden/fr/v1/a.json': entry({ id: 'a', lang: 'fr' }),
      'evals/golden/en/v1/z.json': entry({ id: 'z' }),
      'evals/golden/en/v1/m.json': entry({ id: 'm' }),
    })

    const entries = await loadGoldenEntries(root, { version: 'v1', languages: ['fr', 'en'] })

    expect(entries.map((item) => `${item.lang}:${item.id}`)).toStrictEqual([
      'en:m',
      'en:z',
      'fr:a',
      'fr:b',
    ])
  })

  it('sorts ascending language groups even when the first requested language is English', async () => {
    const root = await makeTree({
      'evals/golden/en/v1/z.json': entry({ id: 'z' }),
      'evals/golden/en/v1/m.json': entry({ id: 'm' }),
      'evals/golden/fr/v1/b.json': entry({ id: 'b', lang: 'fr' }),
      'evals/golden/fr/v1/a.json': entry({ id: 'a', lang: 'fr' }),
    })

    const entries = await loadGoldenEntries(root, { version: 'v1', languages: ['en', 'fr'] })

    expect(entries.map((item) => `${item.lang}:${item.id}`)).toStrictEqual([
      'en:m',
      'en:z',
      'fr:a',
      'fr:b',
    ])
  })

  it('sorts ids inside one language by id, not by file name', async () => {
    const root = await makeTree({
      'evals/golden/en/v1/a.json': entry({ id: 'zzz' }),
      'evals/golden/en/v1/b.json': entry({ id: 'aaa' }),
    })

    const entries = await loadGoldenEntries(root, { version: 'v1', languages: ['en'] })

    expect(entries.map((item) => item.id)).toStrictEqual(['aaa', 'zzz'])
  })

  it('keeps ids that are already in ascending order', async () => {
    const root = await makeTree({
      'evals/golden/en/v1/a.json': entry({ id: 'aaa' }),
      'evals/golden/en/v1/b.json': entry({ id: 'zzz' }),
    })

    const entries = await loadGoldenEntries(root, { version: 'v1', languages: ['en'] })

    expect(entries.map((item) => item.id)).toStrictEqual(['aaa', 'zzz'])
  })

  it('keeps the file order for entries with the same language and id', async () => {
    const root = await makeTree({
      'evals/golden/en/v1/b.json': entry({ id: 'dup', taskId: 'second' }),
      'evals/golden/en/v1/a.json': entry({ id: 'dup', taskId: 'first' }),
    })

    const entries = await loadGoldenEntries(root, { version: 'v1', languages: ['en'] })

    expect(entries.map((item) => item.taskId)).toStrictEqual(['first', 'second'])
  })

  it('walks nested directories and ignores files that are not .json', async () => {
    const root = await makeTree({
      'evals/golden/en/v1/batch/deep/a.json': entry({ id: 'nested' }),
      'evals/golden/en/v1/notes.md': '# not a golden entry',
      'evals/golden/en/v1/UPPER.JSON': entry({ id: 'upper' }),
    })

    const entries = await loadGoldenEntries(root, { version: 'v1', languages: ['en'] })

    expect(entries.map((item) => item.id)).toStrictEqual(['nested'])
  })

  it('returns an empty list for a missing language or version directory', async () => {
    const root = await makeTree({
      'evals/golden/en/v1/a.json': entry(),
    })

    expect(await loadGoldenEntries(root, { version: 'v9', languages: ['en', 'fr'] })).toStrictEqual(
      [],
    )
  })

  it('returns an empty list when evals/golden does not exist', async () => {
    const root = await makeTree({ 'evals/tasks/keep.txt': 'x' })

    expect(await loadGoldenEntries(root, { version: 'v1', languages: ['en'] })).toStrictEqual([])
  })

  it('rejects invalid JSON instead of returning a partial list', async () => {
    const root = await makeTree({
      'evals/golden/en/v1/broken.json': '{ "id": ',
    })

    await expect(
      loadGoldenEntries(root, { version: 'v1', languages: ['en'] }),
    ).rejects.toMatchObject({ name: 'SyntaxError' })
  })

  it('rejects an entry that fails the golden schema', async () => {
    const root = await makeTree({
      'evals/golden/en/v1/invalid.json': { id: 'golden-1', lang: 'en' },
    })

    const error = await loadGoldenEntries(root, { version: 'v1', languages: ['en'] }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('ZodError')
  })

  it('rejects when the version path is a file rather than a directory', async () => {
    const root = await makeTree({
      'evals/golden/en/v1': 'not a directory',
    })

    const error = await loadGoldenEntries(root, { version: 'v1', languages: ['en'] }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as NodeJS.ErrnoException).code).toBe('ENOTDIR')
  })

  it.skipIf(process.getuid?.() === 0)('rejects an unreadable entry file', async () => {
    const root = await makeTree({
      'evals/golden/en/v1/locked.json': entry(),
    })
    const file = join(root, 'evals/golden/en/v1/locked.json')
    await chmod(file, 0o000)

    const error = await loadGoldenEntries(root, { version: 'v1', languages: ['en'] }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as NodeJS.ErrnoException).code).toBe('EACCES')
  })
})

describe('goldenIndexByTask', () => {
  it('keys entries by language and task id, skipping entries without a task id', () => {
    const withTask = entry({ id: 'golden-1', taskId: 'task-001' })
    const withoutTask = entry({ id: 'golden-2', taskId: undefined })

    const index = goldenIndexByTask([withoutTask, withTask])

    expect([...index.keys()]).toStrictEqual(['en:task-001'])
    expect(index.get('en:task-001')).toBe(withTask)
  })

  it('separates the same task id across languages', () => {
    const english = entry({ id: 'en-golden', taskId: 'task-1' })
    const french = entry({ id: 'fr-golden', lang: 'fr', taskId: 'task-1' })

    const index = goldenIndexByTask([english, french])

    expect(index.size).toBe(2)
    expect(index.get('en:task-1')).toBe(english)
    expect(index.get('fr:task-1')).toBe(french)
  })

  it('keeps the last entry for a repeated language and task id', () => {
    const first = entry({ id: 'first', taskId: 'task-1' })
    const second = entry({ id: 'second', taskId: 'task-1' })

    const index = goldenIndexByTask([first, second])

    expect(index.size).toBe(1)
    expect(index.get('en:task-1')).toBe(second)
  })

  it('returns an empty map for an empty list', () => {
    expect(goldenIndexByTask([]).size).toBe(0)
  })
})
