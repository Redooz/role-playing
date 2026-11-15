import { describe, expect, it } from 'vitest'
import { compositionScope, parseComposition, parseCompositionPath } from './composition-file.js'
import { compositionFile, compositionSlice } from './task-tree.fixtures.js'

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

describe('composition file path', () => {
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

  it('names a version scope as dataset/version', () => {
    expect(compositionScope('synthetic-routing', '1.1.0')).toBe('synthetic-routing/1.1.0')
  })
})
