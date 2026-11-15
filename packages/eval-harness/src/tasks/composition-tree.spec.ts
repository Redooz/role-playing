import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GRANDFATHERED_COMPOSITIONS, compositionPath, isGrandfathered } from './composition.js'

/**
 * The committed tree must honour the composition rule (M3c P2).
 *
 * Today every dataset version predates the rule, so the whole file is inert.
 * The spec still fails the moment a version is added without its composition:
 * `1.1.0` and `m3b-v2` must declare one, and only the four grandfathered pairs
 * may omit it.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const TASKS_ROOT = join(REPO_ROOT, 'evals/tasks')

async function directoryNames(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

async function datasetVersions(): Promise<{ dataset: string; version: string }[]> {
  const pairs: { dataset: string; version: string }[] = []
  for (const dataset of await directoryNames(TASKS_ROOT)) {
    for (const version of await directoryNames(join(TASKS_ROOT, dataset))) {
      pairs.push({ dataset, version })
    }
  }
  return pairs.sort((left, right) =>
    `${left.dataset}/${left.version}`.localeCompare(`${right.dataset}/${right.version}`),
  )
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

describe('committed task tree composition', () => {
  it('grandfathers exactly the four pairs that predate the rule', () => {
    expect(GRANDFATHERED_COMPOSITIONS).toEqual([
      'synthetic-routing/1.0.0',
      'synthetic-multi-persona-session/m3b-v1',
      'synthetic-workplace/v1',
      'synthetic-workplace-session/v1',
    ])
  })

  it('names only dataset versions that exist in the tree', async () => {
    const pairs = new Set(
      (await datasetVersions()).map((pair) => `${pair.dataset}/${pair.version}`),
    )

    for (const grandfathered of GRANDFATHERED_COMPOSITIONS) {
      expect(pairs.has(grandfathered), `${grandfathered} is not in evals/tasks`).toBe(true)
    }
  })

  it('declares a composition for every pair that is not grandfathered', async () => {
    const undeclared: string[] = []
    for (const { dataset, version } of await datasetVersions()) {
      if (isGrandfathered(dataset, version)) continue
      if (await exists(join(REPO_ROOT, compositionPath(dataset, version)))) continue
      undeclared.push(`${dataset}/${version}`)
    }

    expect(
      undeclared,
      'a new dataset version must declare evals/tasks/<dataset>/<version>/composition.json',
    ).toEqual([])
  })
})
