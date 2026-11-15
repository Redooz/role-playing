import { afterEach, describe, expect, it } from 'vitest'
import {
  checkCompositions,
  declaredSlices,
  parseComposition,
  parseCompositionPath,
  resolveCompositionUnits,
  sliceKey,
  compositionScope,
  GRANDFATHERED_COMPOSITIONS,
  isGrandfathered,
} from './composition.js'
import type { GoldenEntry, TaskEntry } from './schema.js'
import type { TaskViolation } from './violations.js'
import { validateTaskTree } from './validate.js'
import {
  cleanupTempDirs,
  compositionFile,
  compositionFilePath,
  compositionSlice,
  goldenEntry,
  goldenPath,
  makeTree,
  routingContext,
  routingGolden,
  routingTask,
  taskEntry,
  taskPath,
} from './task-tree.fixtures.js'
import { multiPersonaTask } from '../runner/session.fixtures.js'

const ROUTING_DATASET = 'synthetic-routing'
const ROUTING_VERSION = '1.1.0'
const ROUTING_COMPOSITION = compositionFilePath(ROUTING_DATASET, ROUTING_VERSION)

afterEach(cleanupTempDirs)

function routingDecision(
  id: string,
  split: 'calibration' | 'holdout' = 'holdout',
  overrides: Partial<TaskEntry> = {},
): TaskEntry {
  return routingTask({
    id,
    split,
    speakerId: `speaker-${id}`,
    routing: { context: { ...routingContext, decisionId: id } },
    ...overrides,
  })
}

interface LabelOptions {
  readonly acceptablePersonaIds?: readonly string[]
  readonly allowUserYield?: boolean
  readonly family?: string
  readonly distractor?: boolean
  readonly split?: 'calibration' | 'holdout'
}

function routingLabel(
  taskId: string,
  options: LabelOptions = {},
  overrides: Partial<GoldenEntry> = {},
): GoldenEntry {
  return routingGolden({
    id: `golden-${taskId}`,
    taskId,
    split: options.split ?? 'holdout',
    routingOutcome: {
      intent: 'confirm-handoff',
      acceptablePersonaIds: [...(options.acceptablePersonaIds ?? ['peer'])],
      allowUserYield: options.allowUserYield ?? false,
      labelSource: 'agent',
      ...(options.family === undefined ? {} : { family: options.family }),
      ...(options.distractor === undefined ? {} : { distractor: options.distractor }),
    },
    ...overrides,
  })
}

/** One speak-required and one silence-required routing decision, with their labels. */
function twoSidedTree(composition?: unknown, files: Record<string, unknown> = {}): Promise<string> {
  const tree: Record<string, unknown> = {
    [taskPath('en', 'speak', ROUTING_DATASET, ROUTING_VERSION)]: routingDecision('routing-speak-1'),
    [taskPath('en', 'silence', ROUTING_DATASET, ROUTING_VERSION)]:
      routingDecision('routing-silence-1'),
    [goldenPath('en', 'speak', ROUTING_VERSION)]: routingLabel('routing-speak-1'),
    [goldenPath('en', 'silence', ROUTING_VERSION)]: routingLabel('routing-silence-1', {
      acceptablePersonaIds: [],
      allowUserYield: true,
    }),
    ...files,
  }
  if (composition !== undefined) tree[ROUTING_COMPOSITION] = composition
  return makeTree(tree)
}

describe('parseComposition', () => {
  it('parses a valid composition', () => {
    const parsed = parseComposition(compositionFile())

    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.composition.unit).toBe('routing_outcome')
  })

  it.each([
    [
      'a negative count',
      {
        ...compositionFile(),
        splits: {
          holdout: { en: { ...compositionSlice(), classes: { speak: -1, silence: 1, mixed: 0 } } },
        },
      },
    ],
    [
      'a missing mixed count',
      {
        ...compositionFile(),
        splits: { holdout: { en: { ...compositionSlice(), classes: { speak: 1, silence: 1 } } } },
      },
    ],
    ['an unknown split', { ...compositionFile(), splits: { test: { en: compositionSlice() } } }],
    [
      'an unknown language',
      { ...compositionFile(), splits: { holdout: { de: compositionSlice() } } },
    ],
    ['an unknown unit', { ...compositionFile(), unit: 'per_turn' }],
    ['an old schema version', { ...compositionFile(), schemaVersion: 0 }],
    [
      'a missing constraint block',
      {
        ...compositionFile(),
        splits: { holdout: { en: { classes: { speak: 1, silence: 1, mixed: 0 } } } },
      },
    ],
    ['an unknown top-level key', { ...compositionFile(), note: 'extra' }],
    ['a non-object value', 'composition'],
  ])('rejects %s', (_name, value) => {
    const parsed = parseComposition(value)

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues.length).toBeGreaterThan(0)
  })

  it('reports the failing field in the issue text', () => {
    const parsed = parseComposition({ ...compositionFile(), unit: 'per_turn' })

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues[0]).toContain('unit')
  })
})

describe('composition path and grandfather list', () => {
  it('reserves exactly the version-root path', () => {
    expect(parseCompositionPath('tasks/synthetic-routing/1.1.0/composition.json')).toStrictEqual({
      dataset: 'synthetic-routing',
      version: '1.1.0',
      scope: 'synthetic-routing/1.1.0',
    })
  })

  it.each([
    ['a golden path', 'golden/en/v1/composition.json'],
    ['a language directory', 'tasks/synthetic-routing/1.1.0/en/composition.json'],
    ['a nested directory', 'tasks/synthetic-routing/1.1.0/en/batch/composition.json'],
    ['the dataset root', 'tasks/synthetic-routing/composition.json'],
    ['a trailing segment', 'tasks/synthetic-routing/1.1.0/composition.json/extra'],
    ['another file name', 'tasks/synthetic-routing/1.1.0/other.json'],
    ['an empty dataset', 'tasks//1.1.0/composition.json'],
    ['an empty version', 'tasks/synthetic-routing//composition.json'],
    ['an empty path', ''],
  ])('does not reserve %s', (_name, path) => {
    expect(parseCompositionPath(path)).toBeUndefined()
  })

  it('grandfathers exactly the four pairs that predate the rule', () => {
    expect(GRANDFATHERED_COMPOSITIONS).toEqual([
      'synthetic-routing/1.0.0',
      'synthetic-multi-persona-session/m3b-v1',
      'synthetic-workplace/v1',
      'synthetic-workplace-session/v1',
    ])
    expect(isGrandfathered('synthetic-routing', '1.0.0')).toBe(true)
    expect(isGrandfathered('synthetic-routing', '1.1.0')).toBe(false)
    expect(isGrandfathered('synthetic-workplace', 'v2')).toBe(false)
    expect(compositionScope('synthetic-routing', '1.1.0')).toBe('synthetic-routing/1.1.0')
  })

  it('lists declared slices in split then language order', () => {
    const composition = compositionFile({
      splits: {
        calibration: { fr: compositionSlice() },
        holdout: { en: compositionSlice(), fr: compositionSlice() },
      },
    })

    expect(declaredSlices(composition).map((entry) => sliceKey(entry.split, entry.lang))).toEqual([
      'calibration/fr',
      'holdout/en',
      'holdout/fr',
    ])
  })
})

describe('resolveCompositionUnits', () => {
  const task = {
    dataset: ROUTING_DATASET,
    version: ROUTING_VERSION,
    lang: 'en' as const,
    locale: 'en',
    split: 'holdout' as const,
    id: 'routing-1',
    path: taskPath('en', 'routing', ROUTING_DATASET, ROUTING_VERSION),
  }
  const label = {
    lang: 'en' as const,
    version: ROUTING_VERSION,
    locale: 'en',
    split: 'holdout' as const,
    taskId: 'routing-1',
    routingOutcome: { acceptablePersonaIds: ['peer'], allowUserYield: false },
    path: goldenPath('en', 'routing', ROUTING_VERSION),
  }

  it('counts one unit per routing label and classifies it', () => {
    expect(resolveCompositionUnits('routing_outcome', [task], [label])).toStrictEqual([
      {
        split: 'holdout',
        lang: 'en',
        labelClass: 'speak',
        family: undefined,
        distractor: undefined,
        path: label.path,
      },
    ])
  })

  it('counts every label a task carries', () => {
    const second = { ...label, path: goldenPath('en', 'routing-round-2', ROUTING_VERSION) }

    expect(resolveCompositionUnits('routing_outcome', [task], [label, second])).toHaveLength(2)
  })

  it('skips a label record that carries no routing outcome', () => {
    expect(
      resolveCompositionUnits('routing_outcome', [task], [{ ...label, routingOutcome: undefined }]),
    ).toEqual([])
  })

  it('skips a label whose split disagrees with its task', () => {
    expect(
      resolveCompositionUnits('routing_outcome', [{ ...task, split: 'calibration' }], [label]),
    ).toEqual([])
  })

  it('ignores routing labels for the speaker unit and labels without a task id', () => {
    expect(resolveCompositionUnits('speaker_label', [task], [label])).toEqual([])
    expect(
      resolveCompositionUnits('routing_outcome', [task], [{ ...label, taskId: undefined }]),
    ).toEqual([])
  })
})

describe('composition rules in the tree walker', () => {
  it('accepts a composition whose counts match the labels present', async () => {
    expect(await validateTaskTree(await twoSidedTree(compositionFile()))).toEqual([])
  })

  it('checks each declared slice against its own units', async () => {
    const root = await makeTree({
      [taskPath('en', 'cal-speak', ROUTING_DATASET, ROUTING_VERSION)]: routingDecision(
        'routing-cal-speak',
        'calibration',
      ),
      [taskPath('en', 'cal-silence', ROUTING_DATASET, ROUTING_VERSION)]: routingDecision(
        'routing-cal-silence',
        'calibration',
      ),
      [taskPath('en', 'hold-speak', ROUTING_DATASET, ROUTING_VERSION)]:
        routingDecision('routing-hold-speak'),
      [taskPath('en', 'hold-silence', ROUTING_DATASET, ROUTING_VERSION)]:
        routingDecision('routing-hold-silence'),
      [goldenPath('en', 'cal-speak', ROUTING_VERSION)]: routingLabel('routing-cal-speak', {
        split: 'calibration',
      }),
      [goldenPath('en', 'cal-silence', ROUTING_VERSION)]: routingLabel('routing-cal-silence', {
        split: 'calibration',
        acceptablePersonaIds: [],
        allowUserYield: true,
      }),
      [goldenPath('en', 'hold-speak', ROUTING_VERSION)]: routingLabel('routing-hold-speak'),
      [goldenPath('en', 'hold-silence', ROUTING_VERSION)]: routingLabel('routing-hold-silence', {
        acceptablePersonaIds: [],
        allowUserYield: true,
      }),
      [ROUTING_COMPOSITION]: compositionFile({
        splits: {
          calibration: { en: compositionSlice() },
          holdout: { en: compositionSlice() },
        },
      }),
    })

    expect(await validateTaskTree(root)).toEqual([])
  })

  it('reports a class count that differs from the labels', async () => {
    const composition = compositionFile({
      splits: {
        holdout: { en: compositionSlice({ classes: { speak: 2, silence: 1, mixed: 0 } }) },
      },
    })

    expect(await validateTaskTree(await twoSidedTree(composition))).toStrictEqual([
      {
        path: ROUTING_COMPOSITION,
        code: 'COMPOSITION_MISMATCH',
        message: 'class "speak" for holdout/en is declared as 2 but 1 label(s) exist',
      },
    ])
  })

  it('rejects a one-sided declaration even when the counts match', async () => {
    const root = await makeTree({
      [taskPath('en', 'speak', ROUTING_DATASET, ROUTING_VERSION)]:
        routingDecision('routing-speak-1'),
      [goldenPath('en', 'speak', ROUTING_VERSION)]: routingLabel('routing-speak-1'),
      [ROUTING_COMPOSITION]: compositionFile({
        splits: {
          holdout: { en: compositionSlice({ classes: { speak: 1, silence: 0, mixed: 0 } }) },
        },
      }),
    })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: ROUTING_COMPOSITION,
        code: 'COMPOSITION_ONE_SIDED',
        message:
          'holdout/en declares speak 1 and silence 0; both classes must be greater than zero',
      },
    ])
  })

  it('rejects a declaration that drops the speak class', async () => {
    const root = await makeTree({
      [taskPath('en', 'silence', ROUTING_DATASET, ROUTING_VERSION)]:
        routingDecision('routing-silence-1'),
      [goldenPath('en', 'silence', ROUTING_VERSION)]: routingLabel('routing-silence-1', {
        acceptablePersonaIds: [],
        allowUserYield: true,
      }),
      [ROUTING_COMPOSITION]: compositionFile({
        splits: {
          holdout: { en: compositionSlice({ classes: { speak: 0, silence: 1, mixed: 0 } }) },
        },
      }),
    })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: ROUTING_COMPOSITION,
        code: 'COMPOSITION_ONE_SIDED',
        message:
          'holdout/en declares speak 0 and silence 1; both classes must be greater than zero',
      },
    ])
  })

  it('checks each declared language against its own units', async () => {
    const root = await makeTree({
      [taskPath('en', 'speak', ROUTING_DATASET, ROUTING_VERSION)]:
        routingDecision('routing-speak-1'),
      [taskPath('en', 'silence', ROUTING_DATASET, ROUTING_VERSION)]:
        routingDecision('routing-silence-1'),
      // A French task with no label: the composition must not borrow the English
      // units to satisfy the French slice.
      [taskPath('fr', 'task', ROUTING_DATASET, ROUTING_VERSION)]: taskEntry({
        id: 'fr-task',
        lang: 'fr',
        split: 'holdout',
        speakerId: 'speaker-fr',
      }),
      [goldenPath('en', 'speak', ROUTING_VERSION)]: routingLabel('routing-speak-1'),
      [goldenPath('en', 'silence', ROUTING_VERSION)]: routingLabel('routing-silence-1', {
        acceptablePersonaIds: [],
        allowUserYield: true,
      }),
      [ROUTING_COMPOSITION]: compositionFile({
        splits: { holdout: { en: compositionSlice(), fr: compositionSlice() } },
      }),
    })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: ROUTING_COMPOSITION,
        code: 'COMPOSITION_MISMATCH',
        message: 'class "silence" for holdout/fr is declared as 1 but 0 label(s) exist',
      },
      {
        path: ROUTING_COMPOSITION,
        code: 'COMPOSITION_MISMATCH',
        message: 'class "speak" for holdout/fr is declared as 1 but 0 label(s) exist',
      },
    ])
  })

  it('requires every split and language in the tree to be declared', async () => {
    const composition = compositionFile({ splits: { calibration: { en: compositionSlice() } } })

    expect(await validateTaskTree(await twoSidedTree(composition))).toStrictEqual([
      {
        path: ROUTING_COMPOSITION,
        code: 'COMPOSITION_MISMATCH',
        message: 'calibration/en is declared but the task tree has no tasks for it',
      },
      {
        path: ROUTING_COMPOSITION,
        code: 'COMPOSITION_MISMATCH',
        message: 'holdout/en has tasks but the composition does not declare it',
      },
    ])
  })

  it('rejects a declared slice when the version has no tasks at all', async () => {
    const root = await makeTree({
      [compositionFilePath('synthetic-workplace', 'v2')]: compositionFile({
        dataset: 'synthetic-workplace',
        version: 'v2',
      }),
    })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: compositionFilePath('synthetic-workplace', 'v2'),
        code: 'COMPOSITION_MISMATCH',
        message: 'holdout/en is declared but the task tree has no tasks for it',
      },
    ])
  })

  it('rejects a composition whose dataset does not match its path', async () => {
    const composition = compositionFile({ dataset: 'synthetic-workplace' })

    expect(await validateTaskTree(await twoSidedTree(composition))).toStrictEqual([
      {
        path: ROUTING_COMPOSITION,
        code: 'COMPOSITION_MISMATCH',
        message:
          'declared dataset "synthetic-workplace" does not match the path "synthetic-routing"',
      },
    ])
  })

  it('rejects a composition whose version does not match its path', async () => {
    const composition = compositionFile({ version: '9.9.9' })

    expect(await validateTaskTree(await twoSidedTree(composition))).toStrictEqual([
      {
        path: ROUTING_COMPOSITION,
        code: 'COMPOSITION_MISMATCH',
        message: 'declared version "9.9.9" does not match the path "1.1.0"',
      },
    ])
  })

  it('reports a malformed composition instead of throwing', async () => {
    const root = await twoSidedTree({ ...compositionFile(), unit: 'per_turn' })

    const violations = await validateTaskTree(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ path: ROUTING_COMPOSITION, code: 'INVALID_COMPOSITION' })
    expect(violations[0]?.message).toContain('unit')
  })

  it('reports unparsable composition JSON under the composition code', async () => {
    const root = await makeTree({ [ROUTING_COMPOSITION]: '{ "unit": ' })

    const violations = await validateTaskTree(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ path: ROUTING_COMPOSITION, code: 'INVALID_COMPOSITION' })
    expect(violations[0]?.message).toContain('invalid JSON')
  })

  it('requires a family on every label when minFamilies is set', async () => {
    const root = await twoSidedTree(
      compositionFile({
        splits: { holdout: { en: compositionSlice({ minFamilies: 2 }) } },
      }),
      {
        [goldenPath('en', 'speak', ROUTING_VERSION)]: routingLabel('routing-speak-1', {
          family: 'greeting',
        }),
      },
    )

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: goldenPath('en', 'silence', ROUTING_VERSION),
        code: 'COMPOSITION_FAMILY',
        message: 'label has no family but holdout/en requires at least 2',
      },
      {
        path: ROUTING_COMPOSITION,
        code: 'COMPOSITION_FAMILY',
        message: 'holdout/en requires at least 2 families but the labels use 1',
      },
    ])
  })

  it('bounds a family with maxPerFamily', async () => {
    const root = await twoSidedTree(
      compositionFile({
        splits: {
          holdout: {
            en: compositionSlice({
              classes: { speak: 2, silence: 1, mixed: 0 },
              maxPerFamily: 1,
            }),
          },
        },
      }),
      {
        [taskPath('en', 'speak-two', ROUTING_DATASET, ROUTING_VERSION)]:
          routingDecision('routing-speak-2'),
        [goldenPath('en', 'speak', ROUTING_VERSION)]: routingLabel('routing-speak-1', {
          family: 'greeting',
        }),
        [goldenPath('en', 'speak-two', ROUTING_VERSION)]: routingLabel('routing-speak-2', {
          family: 'greeting',
        }),
        [goldenPath('en', 'silence', ROUTING_VERSION)]: routingLabel('routing-silence-1', {
          acceptablePersonaIds: [],
          allowUserYield: true,
          family: 'question',
        }),
      },
    )

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: ROUTING_COMPOSITION,
        code: 'COMPOSITION_FAMILY',
        message: 'family "greeting" has 2 labels in holdout/en, above maxPerFamily 1',
      },
    ])
  })

  it('accepts exactly minFamilies distinct families', async () => {
    const root = await twoSidedTree(
      compositionFile({
        splits: { holdout: { en: compositionSlice({ minFamilies: 2 }) } },
      }),
      {
        [goldenPath('en', 'speak', ROUTING_VERSION)]: routingLabel('routing-speak-1', {
          family: 'greeting',
        }),
        [goldenPath('en', 'silence', ROUTING_VERSION)]: routingLabel('routing-silence-1', {
          acceptablePersonaIds: [],
          allowUserYield: true,
          family: 'question',
        }),
      },
    )

    expect(await validateTaskTree(root)).toEqual([])
  })

  it('does not count a label without a family toward maxPerFamily', async () => {
    const root = await makeTree({
      [taskPath('en', 'speak', ROUTING_DATASET, ROUTING_VERSION)]:
        routingDecision('routing-speak-1'),
      [taskPath('en', 'speak-two', ROUTING_DATASET, ROUTING_VERSION)]:
        routingDecision('routing-speak-2'),
      [taskPath('en', 'silence', ROUTING_DATASET, ROUTING_VERSION)]:
        routingDecision('routing-silence-1'),
      [taskPath('en', 'silence-two', ROUTING_DATASET, ROUTING_VERSION)]:
        routingDecision('routing-silence-2'),
      [goldenPath('en', 'speak', ROUTING_VERSION)]: routingLabel('routing-speak-1', {
        family: 'greeting',
      }),
      [goldenPath('en', 'speak-two', ROUTING_VERSION)]: routingLabel('routing-speak-2', {
        family: 'greeting',
      }),
      [goldenPath('en', 'silence', ROUTING_VERSION)]: routingLabel('routing-silence-1', {
        acceptablePersonaIds: [],
        allowUserYield: true,
      }),
      [goldenPath('en', 'silence-two', ROUTING_VERSION)]: routingLabel('routing-silence-2', {
        acceptablePersonaIds: [],
        allowUserYield: true,
      }),
      [ROUTING_COMPOSITION]: compositionFile({
        splits: {
          holdout: {
            en: compositionSlice({
              classes: { speak: 2, silence: 2, mixed: 0 },
              maxPerFamily: 1,
            }),
          },
        },
      }),
    })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: ROUTING_COMPOSITION,
        code: 'COMPOSITION_FAMILY',
        message: 'family "greeting" has 2 labels in holdout/en, above maxPerFamily 1',
      },
    ])
  })

  it('requires the declared number of distractors', async () => {
    const root = await twoSidedTree(
      compositionFile({
        splits: { holdout: { en: compositionSlice({ minDistractors: 2 }) } },
      }),
      {
        [goldenPath('en', 'speak', ROUTING_VERSION)]: routingLabel('routing-speak-1', {
          distractor: true,
        }),
      },
    )

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: ROUTING_COMPOSITION,
        code: 'COMPOSITION_DISTRACTOR',
        message: 'holdout/en requires at least 2 distractor(s) but 1 label(s) are marked',
      },
    ])
  })

  it('accepts the declared number of distractors', async () => {
    const composition = compositionFile({
      splits: { holdout: { en: compositionSlice({ minDistractors: 2 }) } },
    })

    expect(
      await validateTaskTree(
        await twoSidedTree(composition, {
          [goldenPath('en', 'speak', ROUTING_VERSION)]: routingLabel('routing-speak-1', {
            distractor: true,
          }),
          [goldenPath('en', 'silence', ROUTING_VERSION)]: routingLabel('routing-silence-1', {
            acceptablePersonaIds: [],
            allowUserYield: true,
            distractor: true,
          }),
        }),
      ),
    ).toEqual([])
  })

  it.each([
    'evals/tasks/synthetic-routing/1.1.0/en/composition.json',
    'evals/tasks/synthetic-routing/composition.json',
    'evals/tasks/composition.json',
  ])('rejects composition.json outside the reserved path: %s', async (path) => {
    const root = await makeTree({ [path]: compositionFile() })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path,
        code: 'INVALID_LAYOUT',
        message:
          'composition.json is only allowed at evals/tasks/<dataset>/<version>/composition.json',
      },
    ])
  })

  it('reports a missing composition for a version past the grandfather list', async () => {
    const path = taskPath('en', 'task', 'synthetic-workplace', 'v2')
    const root = await makeTree({ [path]: taskEntry() })

    expect(await validateTaskTree(root)).toStrictEqual([
      {
        path: compositionFilePath('synthetic-workplace', 'v2'),
        code: 'COMPOSITION_MISSING',
        message:
          '"synthetic-workplace/v2" declares no composition and is not on the grandfather list',
      },
    ])
  })

  it('skips a grandfathered version without a composition', async () => {
    const root = await makeTree({
      [taskPath('en', 'task', 'synthetic-routing', '1.0.0')]: taskEntry(),
    })

    expect(await validateTaskTree(root)).toEqual([])
  })
})

describe('speaker-label composition', () => {
  const DATASET = 'synthetic-multi-persona-session'
  const VERSION = 'm3b-v2'
  const COMPOSITION = compositionFilePath(DATASET, VERSION)

  function sessionTree(classes: {
    speak: number
    silence: number
    mixed: number
  }): Promise<string> {
    const task: TaskEntry = { ...multiPersonaTask(), split: 'holdout' }
    return makeTree({
      [taskPath('en', 'scope', DATASET, VERSION)]: task,
      [goldenPath('en', 'scope', VERSION)]: goldenEntry({
        id: 'golden-en-scope',
        lang: 'en',
        split: 'holdout',
        taskId: task.id,
        routingLabels: undefined,
        dimensionScores: undefined,
        speakerLabels: [
          {
            turnIndex: 0,
            acceptablePersonaIds: ['peer'],
            allowUserYield: false,
            labelSource: 'agent',
          },
          {
            turnIndex: 1,
            acceptablePersonaIds: [],
            allowUserYield: true,
            labelSource: 'agent',
          },
        ],
      }),
      [COMPOSITION]: compositionFile({
        dataset: DATASET,
        version: VERSION,
        unit: 'speaker_label',
        splits: { holdout: { en: compositionSlice({ classes }) } },
      }),
    })
  }

  it('counts one unit per speaker label', async () => {
    expect(await validateTaskTree(await sessionTree({ speak: 1, silence: 1, mixed: 0 }))).toEqual(
      [],
    )
  })

  it('reports a speaker-label count that differs', async () => {
    expect(
      await validateTaskTree(await sessionTree({ speak: 2, silence: 1, mixed: 0 })),
    ).toStrictEqual([
      {
        path: COMPOSITION,
        code: 'COMPOSITION_MISMATCH',
        message: 'class "speak" for holdout/en is declared as 2 but 1 label(s) exist',
      },
    ])
  })
})

describe('checkCompositions ordering', () => {
  function record(dataset: string, split: 'calibration' | 'holdout', id: string) {
    return {
      dataset,
      version: '1.0.0',
      lang: 'en' as const,
      locale: 'en',
      split,
      id,
      path: taskPath('en', id, dataset, '1.0.0'),
    }
  }

  it('reports dataset versions in a stable order', () => {
    const violations: TaskViolation[] = []

    checkCompositions(
      {
        tasks: [record('z-dataset', 'holdout', 'z-task'), record('a-dataset', 'holdout', 'a-task')],
        labels: [],
        files: new Map(),
      },
      violations,
    )

    expect(violations.map((violation) => violation.path)).toEqual([
      compositionFilePath('a-dataset', '1.0.0'),
      compositionFilePath('z-dataset', '1.0.0'),
    ])
  })

  it('reports undeclared slices in a stable order', () => {
    const violations: TaskViolation[] = []
    const composition = compositionFile({ dataset: 'a-dataset', version: '1.0.0', splits: {} })

    checkCompositions(
      {
        tasks: [record('a-dataset', 'holdout', 'hold'), record('a-dataset', 'calibration', 'cal')],
        labels: [],
        files: new Map([
          [
            compositionScope('a-dataset', '1.0.0'),
            { path: compositionFilePath('a-dataset', '1.0.0'), value: composition },
          ],
        ]),
      },
      violations,
    )

    expect(violations.map((violation) => violation.message)).toEqual([
      'calibration/en has tasks but the composition does not declare it',
      'holdout/en has tasks but the composition does not declare it',
    ])
  })
})
