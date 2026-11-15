import { describe, expect, it } from 'vitest'
import {
  collectDuplicateIds,
  collectSplitLeakage,
  registerId,
  registerSpeaker,
  type IdIndex,
  type SpeakerIndex,
} from './tree-index.js'

describe('registerId', () => {
  it('creates a group for a new key with the id, scope and first path', () => {
    const ids: IdIndex = new Map()

    registerId(ids, 'key-1', 'task-001', 'ds/v1/en', 'evals/tasks/ds/v1/en/a.json')

    expect(ids.get('key-1')).toStrictEqual({
      id: 'task-001',
      scope: 'ds/v1/en',
      paths: ['evals/tasks/ds/v1/en/a.json'],
    })
  })

  it('appends later paths to the existing group without changing its id or scope', () => {
    const ids: IdIndex = new Map()

    registerId(ids, 'key-1', 'task-001', 'ds/v1/en', 'evals/tasks/ds/v1/en/a.json')
    registerId(ids, 'key-1', 'other-id', 'other-scope', 'evals/tasks/ds/v1/en/b.json')

    expect(ids.size).toBe(1)
    expect(ids.get('key-1')).toStrictEqual({
      id: 'task-001',
      scope: 'ds/v1/en',
      paths: ['evals/tasks/ds/v1/en/a.json', 'evals/tasks/ds/v1/en/b.json'],
    })
  })

  it('keeps separate keys in separate groups', () => {
    const ids: IdIndex = new Map()

    registerId(ids, 'en', 'task-001', 'ds/v1/en', 'a.json')
    registerId(ids, 'fr', 'task-001', 'ds/v1/fr', 'b.json')

    expect([...ids.keys()]).toStrictEqual(['en', 'fr'])
    expect(ids.get('fr')?.paths).toStrictEqual(['b.json'])
  })
})

describe('collectDuplicateIds', () => {
  it('returns nothing when every id appears once', () => {
    const ids: IdIndex = new Map()
    registerId(ids, 'a', 'task-001', 'ds/v1/en', 'a.json')

    expect(collectDuplicateIds(ids)).toStrictEqual([])
  })

  it('reports every path after the first with the first path in the message', () => {
    const ids: IdIndex = new Map()
    registerId(ids, 'a', 'task-001', 'ds/v1/en', 'evals/tasks/ds/v1/en/a.json')
    registerId(ids, 'a', 'task-001', 'ds/v1/en', 'evals/tasks/ds/v1/en/b.json')
    registerId(ids, 'a', 'task-001', 'ds/v1/en', 'evals/tasks/ds/v1/en/c.json')

    expect(collectDuplicateIds(ids)).toStrictEqual([
      {
        path: 'evals/tasks/ds/v1/en/b.json',
        code: 'DUPLICATE_ID',
        message: 'id "task-001" is already used by evals/tasks/ds/v1/en/a.json within ds/v1/en',
      },
      {
        path: 'evals/tasks/ds/v1/en/c.json',
        code: 'DUPLICATE_ID',
        message: 'id "task-001" is already used by evals/tasks/ds/v1/en/a.json within ds/v1/en',
      },
    ])
  })

  it('reports duplicates in every group independently', () => {
    const ids: IdIndex = new Map()
    registerId(ids, 'en', 'task-001', 'ds/v1/en', 'en/a.json')
    registerId(ids, 'en', 'task-001', 'ds/v1/en', 'en/b.json')
    registerId(ids, 'fr', 'task-001', 'ds/v1/fr', 'fr/a.json')
    registerId(ids, 'fr', 'task-001', 'ds/v1/fr', 'fr/b.json')

    expect(collectDuplicateIds(ids)).toStrictEqual([
      {
        path: 'en/b.json',
        code: 'DUPLICATE_ID',
        message: 'id "task-001" is already used by en/a.json within ds/v1/en',
      },
      {
        path: 'fr/b.json',
        code: 'DUPLICATE_ID',
        message: 'id "task-001" is already used by fr/a.json within ds/v1/fr',
      },
    ])
  })

  it('returns nothing for an empty index', () => {
    expect(collectDuplicateIds(new Map())).toStrictEqual([])
  })
})

describe('registerSpeaker', () => {
  it('creates a scope map and a speaker record on first sight', () => {
    const speakers: SpeakerIndex = new Map()

    registerSpeaker(speakers, 'ds/v1/en', 'speaker-001', 'a.json', 'calibration')

    expect(speakers.get('ds/v1/en')?.get('speaker-001')).toStrictEqual([
      { path: 'a.json', split: 'calibration' },
    ])
  })

  it('appends records for the same speaker in the same scope', () => {
    const speakers: SpeakerIndex = new Map()

    registerSpeaker(speakers, 'ds/v1/en', 'speaker-001', 'a.json', 'calibration')
    registerSpeaker(speakers, 'ds/v1/en', 'speaker-001', 'b.json', 'holdout')

    expect(speakers.size).toBe(1)
    expect(speakers.get('ds/v1/en')?.get('speaker-001')).toStrictEqual([
      { path: 'a.json', split: 'calibration' },
      { path: 'b.json', split: 'holdout' },
    ])
  })

  it('keeps a separate speaker map per scope', () => {
    const speakers: SpeakerIndex = new Map()

    registerSpeaker(speakers, 'ds/v1/en', 'speaker-001', 'en.json', 'calibration')
    registerSpeaker(speakers, 'ds/v1/fr', 'speaker-001', 'fr.json', 'holdout')

    expect(speakers.get('ds/v1/en')?.get('speaker-001')).toStrictEqual([
      { path: 'en.json', split: 'calibration' },
    ])
    expect(speakers.get('ds/v1/fr')?.get('speaker-001')).toStrictEqual([
      { path: 'fr.json', split: 'holdout' },
    ])
  })
})

describe('collectSplitLeakage', () => {
  it('returns nothing when a speaker appears in one split only', () => {
    const speakers: SpeakerIndex = new Map()
    registerSpeaker(speakers, 'ds/v1/en', 'speaker-001', 'a.json', 'calibration')
    registerSpeaker(speakers, 'ds/v1/en', 'speaker-001', 'b.json', 'calibration')

    expect(collectSplitLeakage(speakers)).toStrictEqual([])
  })

  it('reports every record of a speaker that appears in both splits', () => {
    const speakers: SpeakerIndex = new Map()
    registerSpeaker(speakers, 'ds/v1/en', 'speaker-001', 'en/cal-1.json', 'calibration')
    registerSpeaker(speakers, 'ds/v1/en', 'speaker-001', 'en/hold-1.json', 'holdout')
    registerSpeaker(speakers, 'ds/v1/en', 'speaker-001', 'en/cal-2.json', 'calibration')

    expect(collectSplitLeakage(speakers)).toStrictEqual([
      {
        path: 'en/cal-1.json',
        code: 'SPLIT_LEAKAGE',
        message: 'speakerId "speaker-001" appears in both calibration and holdout within ds/v1/en',
      },
      {
        path: 'en/hold-1.json',
        code: 'SPLIT_LEAKAGE',
        message: 'speakerId "speaker-001" appears in both calibration and holdout within ds/v1/en',
      },
      {
        path: 'en/cal-2.json',
        code: 'SPLIT_LEAKAGE',
        message: 'speakerId "speaker-001" appears in both calibration and holdout within ds/v1/en',
      },
    ])
  })

  it('does not merge speakers or scopes', () => {
    const speakers: SpeakerIndex = new Map()
    registerSpeaker(speakers, 'ds/v1/en', 'speaker-001', 'en/1.json', 'calibration')
    registerSpeaker(speakers, 'ds/v1/en', 'speaker-002', 'en/2.json', 'holdout')
    registerSpeaker(speakers, 'ds/v1/fr', 'speaker-001', 'fr/1.json', 'calibration')
    registerSpeaker(speakers, 'ds/v1/fr', 'speaker-001', 'fr/2.json', 'holdout')

    const violations = collectSplitLeakage(speakers)
    expect(violations).toHaveLength(2)
    expect(violations.map((violation) => violation.path)).toStrictEqual(['fr/1.json', 'fr/2.json'])
    expect(violations.every((violation) => violation.message.includes('within ds/v1/fr'))).toBe(
      true,
    )
  })

  it('returns nothing for an empty index', () => {
    expect(collectSplitLeakage(new Map())).toStrictEqual([])
  })
})
