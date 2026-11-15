import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TaskEntry } from '../tasks/schema.js'
import { HarnessConfigError } from './errors.js'
import type { TaskSelection } from './manifest.js'
import { loadSelectedTasks } from './task-loader.js'

/**
 * Specs for the task loader: discovery, validation, filters, coverage and
 * deterministic ordering.
 *
 * Every test writes its own tree under a throwaway temp root and removes it in
 * `finally`, so the repository tree and the real `evals/tasks/` data never take
 * part in these checks.
 */

const DATASET = 'task-loader-probe'
const VERSION = 'v1'

type Lang = 'en' | 'fr'

function taskPath(lang: Lang, name: string): string {
  return `evals/tasks/${DATASET}/${VERSION}/${lang}/${name}`
}

function selection(overrides: Partial<TaskSelection> = {}): TaskSelection {
  return { dataset: DATASET, version: VERSION, languages: ['en'], ...overrides }
}

function task(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: 'task-001',
    lang: 'en',
    mode: 'replay',
    domain: 'workplace',
    scenarioType: 'request-deadline-extension',
    cefrBand: 'B1',
    speakerId: 'speaker-001',
    split: 'calibration',
    provenance: { source: 'synthetic' },
    consentScope: 'synthetic-no-consent-required',
    annotationVersions: { rubric: 'v1' },
    content: { turns: [{ role: 'user', text: 'Could I have two more days?' }] },
    ...overrides,
  }
}

/** Writes `relative path -> JSON value` into a fresh temp root, then cleans up. */
async function withTree(
  files: Record<string, unknown>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'rp-task-loader-'))
  try {
    for (const [relativePath, value] of Object.entries(files)) {
      const target = join(root, relativePath)
      await mkdir(dirname(target), { recursive: true })
      const contents = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      await writeFile(target, contents, 'utf8')
    }
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function configError(run: () => Promise<unknown>): Promise<HarnessConfigError> {
  const error = await run().catch((cause: unknown) => cause)
  expect(error).toBeInstanceOf(HarnessConfigError)
  return error as HarnessConfigError
}

describe('loadSelectedTasks discovery', () => {
  it('rejects a language directory that does not exist', async () => {
    await withTree({}, async (root) => {
      const error = await configError(() => loadSelectedTasks(root, selection()))
      expect(error.message).toBe(
        `no tasks found for language "en" at evals/tasks/${DATASET}/${VERSION}/en`,
      )
    })
  })

  it('collects JSON files recursively in path order and ignores other files', async () => {
    await withTree(
      {
        [taskPath('en', 'a.json')]: task({ id: 'task-a' }),
        [taskPath('en', 'notes.txt')]: 'not json',
        [taskPath('en', 'nested/b.json')]: task({ id: 'task-b' }),
        [taskPath('en', 'nested/deep/c.json')]: task({ id: 'task-c' }),
      },
      async (root) => {
        const loaded = await loadSelectedTasks(root, selection())
        expect(loaded.map(({ task: entry }) => entry.id)).toEqual(['task-a', 'task-b', 'task-c'])
        expect(loaded.map(({ relativePath }) => relativePath)).toEqual([
          `evals/tasks/${DATASET}/${VERSION}/en/a.json`,
          `evals/tasks/${DATASET}/${VERSION}/en/nested/b.json`,
          `evals/tasks/${DATASET}/${VERSION}/en/nested/deep/c.json`,
        ])
      },
    )
  })

  it('rejects a task directory that cannot be read', async () => {
    const directory = `evals/tasks/${DATASET}/${VERSION}/en`
    await withTree({ [directory]: 'not a directory' }, async (root) => {
      const absolute = join(root, directory)
      const error = await configError(() => loadSelectedTasks(root, selection()))
      expect(error.message).toBe(
        `cannot read task directory ${absolute}: ENOTDIR: not a directory, scandir '${absolute}'`,
      )
    })
  })
})

describe('loadSelectedTasks validation', () => {
  it('rejects a task file that cannot be read', async () => {
    const path = taskPath('en', 'a.json')
    await withTree({ [path]: task() }, async (root) => {
      const absolute = join(root, path)
      await chmod(absolute, 0o000)
      const error = await configError(() => loadSelectedTasks(root, selection()))
      expect(error.message).toBe(
        `cannot read task ${path}: EACCES: permission denied, open '${absolute}'`,
      )
    })
  })

  it('rejects a task file that is not JSON', async () => {
    const path = taskPath('en', 'a.json')
    await withTree({ [path]: 'not json' }, async (root) => {
      const error = await configError(() => loadSelectedTasks(root, selection()))
      expect(error.message).toBe(
        `cannot read task ${path}: Unexpected token 'o', "not json" is not valid JSON`,
      )
    })
  })

  it('reports every schema issue with its field path', async () => {
    const path = taskPath('en', 'a.json')
    await withTree({ [path]: { ...task(), id: '', content: { turns: 'nope' } } }, async (root) => {
      const error = await configError(() => loadSelectedTasks(root, selection()))
      expect(error.message).toBe(
        `task ${path} is invalid: id: Too small: expected string to have >=1 characters; content.turns: Invalid input: expected array, received string`,
      )
    })
  })

  it('reports a root-level schema issue without a field path', async () => {
    const path = taskPath('en', 'a.json')
    await withTree({ [path]: [] }, async (root) => {
      const error = await configError(() => loadSelectedTasks(root, selection()))
      expect(error.message).toBe(
        `task ${path} is invalid: <root>: Invalid input: expected object, received array`,
      )
    })
  })

  it('rejects a task whose declared language disagrees with its directory', async () => {
    const path = taskPath('en', 'a.json')
    await withTree({ [path]: task({ lang: 'fr' }) }, async (root) => {
      const error = await configError(() => loadSelectedTasks(root, selection()))
      expect(error.message).toBe(`task ${path} declares lang "fr" but lives under "en"`)
    })
  })
})

describe('loadSelectedTasks filters', () => {
  it('applies the split filter', async () => {
    await withTree(
      {
        [taskPath('en', 'a.json')]: task({ id: 'task-a', split: 'calibration' }),
        [taskPath('en', 'b.json')]: task({ id: 'task-b', split: 'holdout' }),
      },
      async (root) => {
        const loaded = await loadSelectedTasks(root, selection({ splits: ['holdout'] }))
        expect(loaded.map(({ task: entry }) => entry.id)).toEqual(['task-b'])
      },
    )
  })

  it('applies the id filter', async () => {
    await withTree(
      {
        [taskPath('en', 'a.json')]: task({ id: 'task-a' }),
        [taskPath('en', 'b.json')]: task({ id: 'task-b' }),
      },
      async (root) => {
        const loaded = await loadSelectedTasks(root, selection({ ids: ['task-b'] }))
        expect(loaded.map(({ task: entry }) => entry.id)).toEqual(['task-b'])
      },
    )
  })

  it('selects base variants by default and locale variants only when named', async () => {
    await withTree(
      {
        [taskPath('en', 'base.json')]: task({ id: 'task-001' }),
        [taskPath('en', 'variant.json')]: task({ id: 'task-002', locale: 'en-GB' }),
      },
      async (root) => {
        const base = await loadSelectedTasks(root, selection())
        expect(base.map(({ task: entry }) => entry.locale ?? entry.lang)).toEqual(['en'])

        const probe = await loadSelectedTasks(root, selection({ locales: ['en-GB'] }))
        expect(probe.map(({ task: entry }) => entry.locale ?? entry.lang)).toEqual(['en-GB'])
      },
    )
  })

  it('rejects a language left empty by the filters', async () => {
    await withTree(
      {
        [taskPath('en', 'a.json')]: task({ id: 'task-a' }),
        [taskPath('fr', 'b.json')]: task({ id: 'task-b', lang: 'fr', split: 'holdout' }),
      },
      async (root) => {
        const error = await configError(() =>
          loadSelectedTasks(root, selection({ languages: ['en', 'fr'], splits: ['holdout'] })),
        )
        expect(error.message).toBe(
          'manifest selects no task for language "en" after split/id/locale filters',
        )
      },
    )
  })

  it('rejects a locale left empty by the filters', async () => {
    await withTree(
      {
        [taskPath('en', 'base.json')]: task({ id: 'task-a' }),
        [taskPath('en', 'variant.json')]: task({
          id: 'task-b',
          locale: 'en-GB',
          split: 'holdout',
        }),
      },
      async (root) => {
        const error = await configError(() =>
          loadSelectedTasks(root, selection({ locales: ['en', 'en-GB'], splits: ['calibration'] })),
        )
        expect(error.message).toBe(
          'manifest selects no task for locale "en-GB" after split/id filters',
        )
      },
    )
  })
})

describe('loadSelectedTasks duplicates', () => {
  it('rejects a duplicate id in the same language and locale', async () => {
    await withTree(
      {
        [taskPath('en', 'a.json')]: task({ id: 'task-001', locale: 'en' }),
        [taskPath('en', 'nested/b.json')]: task({ id: 'task-001' }),
      },
      async (root) => {
        const error = await configError(() => loadSelectedTasks(root, selection()))
        expect(error.message).toBe(
          'task id "task-001" appears more than once in language "en" locale "en"',
        )
      },
    )
  })

  it('treats a base task and its locale variant with the same id as different keys', async () => {
    await withTree(
      {
        [taskPath('en', 'base.json')]: task({ id: 'task-001' }),
        [taskPath('en', 'variant.json')]: task({ id: 'task-001', locale: 'en-GB' }),
      },
      async (root) => {
        const loaded = await loadSelectedTasks(root, selection({ locales: ['en', 'en-GB'] }))
        expect(loaded.map(({ task: entry }) => entry.locale ?? entry.lang)).toEqual(['en', 'en-GB'])
      },
    )
  })
})

describe('loadSelectedTasks ordering', () => {
  it('orders by selected language order, then task id', async () => {
    // File names and task ids deliberately disagree in both languages, and the
    // id ranges interleave, so only the language-order-then-id comparison can
    // produce the expected result.
    await withTree(
      {
        [taskPath('fr', 'a.json')]: task({ id: 'task-a', lang: 'fr' }),
        [taskPath('fr', 'b.json')]: task({ id: 'task-b', lang: 'fr' }),
        [taskPath('fr', 'c.json')]: task({ id: 'task-c', lang: 'fr' }),
        [taskPath('fr', 'd.json')]: task({ id: 'task-e', lang: 'fr' }),
        [taskPath('en', 'a.json')]: task({ id: 'task-d' }),
        [taskPath('en', 'b.json')]: task({ id: 'task-f' }),
        [taskPath('en', 'c.json')]: task({ id: 'task-h' }),
        [taskPath('en', 'd.json')]: task({ id: 'task-g' }),
      },
      async (root) => {
        const loaded = await loadSelectedTasks(root, selection({ languages: ['fr', 'en'] }))
        expect(loaded.map(({ task: entry }) => `${entry.lang}:${entry.id}`)).toEqual([
          'fr:task-a',
          'fr:task-b',
          'fr:task-c',
          'fr:task-e',
          'en:task-d',
          'en:task-f',
          'en:task-g',
          'en:task-h',
        ])
      },
    )
  })

  it('orders files by their full path, not by directory recursion order', async () => {
    await withTree(
      {
        [taskPath('en', 'a.json')]: task({ id: 'task-001', locale: 'en' }),
        [taskPath('en', 'a/b.json')]: task({ id: 'task-001', locale: 'en-GB' }),
      },
      async (root) => {
        const loaded = await loadSelectedTasks(root, selection({ locales: ['en', 'en-GB'] }))
        expect(loaded.map(({ relativePath }) => relativePath)).toEqual([
          `evals/tasks/${DATASET}/${VERSION}/en/a.json`,
          `evals/tasks/${DATASET}/${VERSION}/en/a/b.json`,
        ])
      },
    )
  })
})
