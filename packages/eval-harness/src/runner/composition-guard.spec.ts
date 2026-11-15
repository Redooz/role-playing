import { mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { GoldenEntry, TaskEntry } from '../tasks/schema.js'
import { assertCompositionCoversSelection } from './composition-guard.js'
import { HarnessConfigError } from './errors.js'
import type { LoadedTask } from './task-loader.js'
import { executeRun } from './runner.js'
import {
  cleanupTempDirs,
  compositionFile,
  compositionFilePath,
  compositionSlice,
  makeTree,
  routingContext,
  routingGolden,
  routingTask,
  taskEntry,
  taskPath,
} from '../tasks/task-tree.fixtures.js'

const DATASET = 'synthetic-routing'
const VERSION = '1.1.0'
const COMPOSITION = compositionFilePath(DATASET, VERSION)
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const BASE_MANIFEST = JSON.parse(
  readFileSync(join(REPO_ROOT, 'evals/manifests/m0-canned-replay.json'), 'utf8'),
) as Record<string, unknown>

afterEach(cleanupTempDirs)

function routingDecision(id: string, split: 'calibration' | 'holdout'): TaskEntry {
  return routingTask({
    id,
    split,
    speakerId: `speaker-${id}`,
    routing: { context: { ...routingContext, decisionId: id } },
  })
}

function routingLabel(
  taskId: string,
  split: 'calibration' | 'holdout',
  kind: 'speak' | 'silence',
): GoldenEntry {
  return routingGolden({
    id: `golden-${taskId}`,
    taskId,
    split,
    routingOutcome: {
      intent: 'confirm-handoff',
      acceptablePersonaIds: kind === 'speak' ? ['peer'] : [],
      allowUserYield: kind === 'silence',
      labelSource: 'agent',
    },
  })
}

function loaded(task: TaskEntry): LoadedTask {
  return { task, relativePath: `evals/tasks/${DATASET}/${VERSION}/${task.lang}/${task.id}.json` }
}

const speakTask = routingDecision('routing-speak-1', 'holdout')
const silenceTask = routingDecision('routing-silence-1', 'holdout')

const goldens: GoldenEntry[] = [
  routingLabel('routing-speak-1', 'holdout', 'speak'),
  routingLabel('routing-silence-1', 'holdout', 'silence'),
]

async function treeWith(composition: unknown = compositionFile()): Promise<string> {
  return makeTree({ [COMPOSITION]: composition })
}

describe('assertCompositionCoversSelection', () => {
  it('passes a selection that keeps every declared class', async () => {
    await expect(
      assertCompositionCoversSelection({
        repoRoot: await treeWith(),
        dataset: DATASET,
        version: VERSION,
        tasks: [loaded(speakTask), loaded(silenceTask)],
        goldens,
      }),
    ).resolves.toBeUndefined()
  })

  it('rejects a filtered selection that loses a class', async () => {
    await expect(
      assertCompositionCoversSelection({
        repoRoot: await treeWith(),
        dataset: DATASET,
        version: VERSION,
        tasks: [loaded(speakTask)],
        goldens,
      }),
    ).rejects.toThrow(/class "silence" for holdout\/en/u)
  })

  it('does not count a unit from another split', async () => {
    const calibrationSpeak = routingDecision('routing-cal-speak-1', 'calibration')
    const calibrationSilence = routingDecision('routing-cal-silence-1', 'calibration')
    const composition = compositionFile({
      splits: { calibration: { en: compositionSlice() }, holdout: { en: compositionSlice() } },
    })

    await expect(
      assertCompositionCoversSelection({
        repoRoot: await treeWith(composition),
        dataset: DATASET,
        version: VERSION,
        tasks: [
          loaded(calibrationSpeak),
          loaded(calibrationSilence),
          loaded(speakTask),
          loaded(silenceTask),
        ],
        goldens: [
          routingLabel('routing-cal-speak-1', 'calibration', 'speak'),
          routingLabel('routing-cal-silence-1', 'calibration', 'silence'),
        ],
      }),
    ).rejects.toThrow(/declares class "speak" for holdout\/en/u)
  })

  it('does not count a unit from another language', async () => {
    const frenchTask: TaskEntry = {
      ...routingDecision('routing-fr-speak-1', 'holdout'),
      lang: 'fr',
      speakerId: 'speaker-fr',
      routing: {
        context: { ...routingContext, decisionId: 'routing-fr-speak-1', lang: 'fr' },
      },
    }
    const composition = compositionFile({
      splits: { holdout: { en: compositionSlice(), fr: compositionSlice() } },
    })

    await expect(
      assertCompositionCoversSelection({
        repoRoot: await treeWith(composition),
        dataset: DATASET,
        version: VERSION,
        tasks: [loaded(speakTask), loaded(silenceTask), loaded(frenchTask)],
        goldens,
      }),
    ).rejects.toThrow(/declares class "speak" for holdout\/fr/u)
  })

  it('names the first undeclared slice in split then language order', async () => {
    const calibration = routingDecision('routing-cal-speak-1', 'calibration')

    await expect(
      assertCompositionCoversSelection({
        repoRoot: await treeWith(compositionFile({ splits: {} })),
        dataset: DATASET,
        version: VERSION,
        // Holdout first: the guard still reports the sorted first slice.
        tasks: [loaded(speakTask), loaded(calibration)],
        goldens,
      }),
    ).rejects.toThrow(/does not declare calibration\/en/u)
  })

  it('skips a grandfathered pair without a composition', async () => {
    const root = await makeTree({ 'evals/README.md': '# evals' })

    await expect(
      assertCompositionCoversSelection({
        repoRoot: root,
        dataset: DATASET,
        version: '1.0.0',
        // A selection that would lose the silence class still runs: the legacy
        // path is skipped, not guessed.
        tasks: [loaded(speakTask)],
        goldens,
      }),
    ).resolves.toBeUndefined()
  })

  it('rejects a non-grandfathered pair that has no composition', async () => {
    const root = await makeTree({ 'evals/README.md': '# evals' })

    await expect(
      assertCompositionCoversSelection({
        repoRoot: root,
        dataset: DATASET,
        version: VERSION,
        tasks: [loaded(speakTask), loaded(silenceTask)],
        goldens,
      }),
    ).rejects.toThrow(/is missing; only a grandfathered version may run without a composition/u)
  })

  it('rejects a selected slice the composition does not declare', async () => {
    const composition = compositionFile({
      splits: { calibration: { en: compositionSlice() } },
    })

    await expect(
      assertCompositionCoversSelection({
        repoRoot: await treeWith(composition),
        dataset: DATASET,
        version: VERSION,
        tasks: [loaded(speakTask), loaded(silenceTask)],
        goldens,
      }),
    ).rejects.toThrow(/does not declare holdout\/en/u)
  })

  it('rejects a composition that names another dataset or version', async () => {
    const root = await treeWith(compositionFile({ dataset: 'synthetic-workplace' }))

    const datasetMismatch = assertCompositionCoversSelection({
      repoRoot: root,
      dataset: DATASET,
      version: VERSION,
      tasks: [loaded(speakTask), loaded(silenceTask)],
      goldens,
    })

    await expect(datasetMismatch).rejects.toThrow(/declares "synthetic-workplace\/1\.1\.0"/u)
    await expect(datasetMismatch).rejects.toThrow(HarnessConfigError)

    await expect(
      assertCompositionCoversSelection({
        repoRoot: await treeWith(compositionFile({ version: '9.9.9' })),
        dataset: DATASET,
        version: VERSION,
        tasks: [loaded(speakTask), loaded(silenceTask)],
        goldens,
      }),
    ).rejects.toThrow(/declares "synthetic-routing\/9\.9\.9"/u)
  })

  it('rejects a composition that does not satisfy the schema', async () => {
    const composition = { ...compositionFile(), unit: 'per_turn' }

    await expect(
      assertCompositionCoversSelection({
        repoRoot: await treeWith(composition),
        dataset: DATASET,
        version: VERSION,
        tasks: [loaded(speakTask), loaded(silenceTask)],
        goldens,
      }),
    ).rejects.toThrow(/is not a valid composition: unit:/u)
  })

  it('lists every schema issue in one message', async () => {
    const composition = { ...compositionFile(), unit: 'per_turn', schemaVersion: 2 }

    const failure = assertCompositionCoversSelection({
      repoRoot: await treeWith(composition),
      dataset: DATASET,
      version: VERSION,
      tasks: [loaded(speakTask), loaded(silenceTask)],
      goldens,
    })

    await expect(failure).rejects.toThrow(/schemaVersion: .*; unit: /u)
  })

  it('rejects a composition that is not JSON', async () => {
    const root = await makeTree({ [COMPOSITION]: '{ "unit": ' })

    await expect(
      assertCompositionCoversSelection({
        repoRoot: root,
        dataset: DATASET,
        version: VERSION,
        tasks: [loaded(speakTask), loaded(silenceTask)],
        goldens,
      }),
    ).rejects.toThrow(/is not valid JSON/u)
  })

  it('reports an unreadable composition as a configuration error', async () => {
    const root = await makeTree({ 'evals/README.md': '# evals' })
    await mkdir(join(root, COMPOSITION), { recursive: true })

    const failure = assertCompositionCoversSelection({
      repoRoot: root,
      dataset: DATASET,
      version: VERSION,
      tasks: [loaded(speakTask), loaded(silenceTask)],
      goldens,
    })

    await expect(failure).rejects.toThrow(HarnessConfigError)
    await expect(failure).rejects.toThrow(/cannot read composition/u)
  })
})

describe('executeRun composition hook', () => {
  it('refuses the run before any trial when the selection loses a class', async () => {
    const root = await makeTree({
      [taskPath('en', 'a', DATASET, VERSION)]: taskEntry({ id: 'task-a', speakerId: 'speaker-a' }),
      [taskPath('en', 'b', DATASET, VERSION)]: taskEntry({ id: 'task-b', speakerId: 'speaker-b' }),
      [COMPOSITION]: compositionFile({ splits: { calibration: { en: compositionSlice() } } }),
    })
    const manifest = {
      ...BASE_MANIFEST,
      run: { ...(BASE_MANIFEST['run'] as object), runId: 'guard-hook', suite: 'guard-hook' },
      tasks: { dataset: DATASET, version: VERSION, languages: ['en'] },
      limits: { rounds: 1, maxFailureRate: 0 },
    }
    let providerCalls = 0

    const run = executeRun({
      repoRoot: root,
      manifest,
      wallClock: () => 0,
      providerFactory: () => {
        providerCalls += 1
        throw new Error('the provider must not be built before the guard passes')
      },
    })

    await expect(run).rejects.toThrow(HarnessConfigError)
    await expect(run).rejects.toThrow(/declares class "speak" for calibration\/en/u)
    expect(providerCalls).toBe(0)
  })
})
