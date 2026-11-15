import { describe, expect, it } from 'vitest'
import { declaredSlices, resolveCompositionUnits, sliceKey } from './composition-units.js'
import { compositionFile, compositionSlice, goldenPath, taskPath } from './task-tree.fixtures.js'

const ROUTING_DATASET = 'synthetic-routing'
const ROUTING_VERSION = '1.1.0'

describe('declaredSlices', () => {
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
