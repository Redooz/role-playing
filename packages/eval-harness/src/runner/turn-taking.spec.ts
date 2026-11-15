import { TRANSCRIPT_SCHEMA_VERSION, type TranscriptRecord } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import type { GoldenEntry, TaskEntry } from '../tasks/schema.js'
import {
  METRIC_ACCEPTABLE_SPEAKER_RATE,
  METRIC_REQUIRED_SPEAKER_RATE,
  METRIC_SILENCE_APPROPRIATE_RATE,
  TURN_TAKING_GRADER_ID,
  TURN_TAKING_GRADER_VERSION,
  createTurnTakingGrader,
  scoreTrialTurnClasses,
  scoreTrialTurnTaking,
} from './turn-taking.js'
import type { TrialRecord } from './grader.js'

function task(personaIds = ['manager', 'peer']): TaskEntry {
  return {
    id: 'task-1',
    lang: 'en',
    locale: 'en',
    mode: 'session',
    domain: 'workplace',
    scenarioType: 'standup-scope-change',
    cefrBand: 'B2',
    speakerId: 'speaker-1',
    split: 'holdout',
    provenance: { source: 'synthetic' },
    consentScope: 'synthetic-no-consent-required',
    annotationVersions: { rubric: 'v1' },
    content: { turns: [] },
    session: {
      personaId: 'manager',
      personaIds,
      personaVersion: '1.0.0',
      scenarioId: 'standup-scope-change',
      scenarioVersion: '1.0.0',
      scriptedUserTurns: ['a', 'b', 'c', 'd'],
    },
  }
}

function golden(): GoldenEntry {
  return {
    id: 'golden-1',
    lang: 'en',
    locale: 'en',
    split: 'holdout',
    taskId: 'task-1',
    speakerLabels: [
      { turnIndex: 0, acceptablePersonaIds: ['peer'], allowUserYield: false, labelSource: 'agent' },
      {
        turnIndex: 1,
        acceptablePersonaIds: ['manager'],
        allowUserYield: false,
        labelSource: 'agent',
      },
      {
        turnIndex: 2,
        acceptablePersonaIds: ['manager', 'peer'],
        allowUserYield: true,
        labelSource: 'agent',
      },
      {
        turnIndex: 3,
        acceptablePersonaIds: ['manager'],
        allowUserYield: false,
        labelSource: 'agent',
      },
    ],
    evidenceSpans: [],
    pairwisePreferences: [],
    status: 'draft',
  }
}

function record(seq: number, kind: string, payload: Record<string, unknown>): TranscriptRecord {
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    runId: 'run-1',
    executionId: 'exec-1',
    seq,
    tSim: seq,
    tWall: 0,
    kind,
    payload,
    contentClass: kind === 'persona.response.chunk' ? 'restricted' : 'contentFree',
  } as TranscriptRecord
}

function granted(grantId: string, personaId: string): TranscriptRecord {
  return record(0, 'turn.granted', {
    grant: {
      turnId: 'turn-1',
      grantId,
      personaId,
      expiresAt: '2026-11-11T00:00:00.000Z',
    },
  })
}

function trial(overrides: Partial<TrialRecord> = {}): TrialRecord {
  return {
    round: 0,
    taskId: 'task-1',
    lang: 'en',
    ok: true,
    records: [
      record(0, 'user.utterance.committed', { text: 'a' }),
      granted('g0', 'peer'),
      record(2, 'user.utterance.committed', { text: 'b' }),
      granted('g1', 'manager'),
      record(4, 'user.utterance.committed', { text: 'c' }),
      record(5, 'user.utterance.committed', { text: 'd' }),
      granted('g3', 'client'),
    ],
    violations: [],
    schemaValid: true,
    sequenceValid: true,
    contentClassValid: true,
    providerOutage: false,
    task: task(),
    golden: golden(),
    ...overrides,
  }
}

describe('turn-taking grader', () => {
  it('counts a turn acceptable when any granted speaker is in the label set', () => {
    expect(scoreTrialTurnTaking(trial())).toEqual({ turns: 4, acceptable: 3 })

    const multiple = trial({
      records: [
        record(0, 'user.utterance.committed', { text: 'a' }),
        granted('g0', 'manager'),
        granted('g0b', 'peer'),
        record(3, 'user.utterance.committed', { text: 'b' }),
      ],
    })
    expect(scoreTrialTurnTaking(multiple)).toEqual({ turns: 4, acceptable: 2 })
  })

  it('returns the acceptable rate and only grades labelled multi-persona trials', async () => {
    const unlabelled = trial({ golden: undefined })
    const single = trial({
      task: task(['manager']),
      golden: { ...golden(), speakerLabels: undefined },
    })
    const grader = createTurnTakingGrader()
    const metrics = await grader.score({
      manifest: {} as never,
      trials: [trial(), unlabelled, single],
    })
    expect(grader).toMatchObject({ id: TURN_TAKING_GRADER_ID, kind: 'code' })
    expect(metrics).toMatchObject({ 'turn_taking.acceptable_speaker_rate': 0.75 })
  })

  it('fails rather than scoring zero when no labelled trial exists', async () => {
    await expect(
      createTurnTakingGrader().score({
        manifest: {} as never,
        trials: [trial({ golden: undefined })],
      }),
    ).rejects.toThrow(/no labelled multi-persona trials/u)
  })

  it('ignores a failed trial even when it has labels', () => {
    expect(scoreTrialTurnTaking(trial({ ok: false }))).toEqual({ turns: 0, acceptable: 0 })
  })
})

describe('turn-taking grants', () => {
  it('ignores a grant that arrives before the first user utterance', () => {
    const records = [
      granted('pre', 'peer'),
      record(1, 'user.utterance.committed', { text: 'a' }),
      granted('g0', 'peer'),
    ]

    expect(scoreTrialTurnTaking(trial({ records }))).toStrictEqual({ turns: 4, acceptable: 2 })
  })

  it('ignores records that are not grants between user turns', () => {
    const records = [
      record(0, 'user.utterance.committed', { text: 'a' }),
      record(1, 'persona.response.chunk', { grantId: 'g0', text: 'x', sequence: 0 }),
      granted('g0', 'peer'),
    ]

    expect(scoreTrialTurnTaking(trial({ records }))).toStrictEqual({ turns: 4, acceptable: 2 })
  })

  it('ignores a grant payload without a grant object', () => {
    const records = [
      record(0, 'user.utterance.committed', { text: 'a' }),
      record(1, 'turn.granted', {}),
    ]

    expect(scoreTrialTurnTaking(trial({ records }))).toStrictEqual({ turns: 4, acceptable: 1 })
  })

  it.each([
    ['missing', undefined],
    ['an empty string', ''],
    ['a number', 42],
  ])('ignores a grant with %s persona id', (_label, personaId) => {
    const records = [
      record(0, 'user.utterance.committed', { text: 'a' }),
      record(1, 'turn.granted', {
        grant: {
          turnId: 'turn-1',
          grantId: 'g0',
          personaId,
          expiresAt: '2026-11-11T00:00:00.000Z',
        },
      }),
    ]

    expect(scoreTrialTurnTaking(trial({ records }))).toStrictEqual({ turns: 4, acceptable: 1 })
  })

  it('accepts a turn with no grant only when the label allows a user yield', () => {
    const records = [
      record(0, 'user.utterance.committed', { text: 'a' }),
      record(1, 'user.utterance.committed', { text: 'b' }),
    ]

    expect(scoreTrialTurnTaking(trial({ records }))).toStrictEqual({ turns: 4, acceptable: 1 })
  })

  it('does not accept a no-grant turn whose label forbids a user yield', () => {
    const records = [record(0, 'user.utterance.committed', { text: 'a' })]

    expect(scoreTrialTurnTaking(trial({ records }))).toStrictEqual({ turns: 4, acceptable: 1 })
  })

  it('accepts a later replacement grant for the same turn', () => {
    const records = [
      record(0, 'user.utterance.committed', { text: 'a' }),
      granted('g0', 'client'),
      granted('g0-replacement', 'peer'),
    ]

    expect(scoreTrialTurnTaking(trial({ records }))).toStrictEqual({ turns: 4, acceptable: 2 })
  })
})

describe('turn-taking eligibility', () => {
  it('does not score a trial without a task', () => {
    expect(scoreTrialTurnTaking(trial({ task: undefined }))).toStrictEqual({
      turns: 0,
      acceptable: 0,
    })
  })

  it('does not score a trial whose task has no session block', () => {
    expect(
      scoreTrialTurnTaking(trial({ task: { ...task(), session: undefined } as never })),
    ).toStrictEqual({ turns: 0, acceptable: 0 })
  })

  it('does not score a task whose session has no persona list', () => {
    const taskWithoutList = { ...task(), session: { ...task().session, personaIds: undefined } }

    expect(scoreTrialTurnTaking(trial({ task: taskWithoutList as never }))).toStrictEqual({
      turns: 0,
      acceptable: 0,
    })
  })

  it('does not score a single-persona task even when it has labels', () => {
    expect(scoreTrialTurnTaking(trial({ task: task(['manager']) }))).toStrictEqual({
      turns: 0,
      acceptable: 0,
    })
  })
})

describe('turn-taking grader contract', () => {
  it('pins the grader id, version, kind and metric name', () => {
    const grader = createTurnTakingGrader()

    expect(grader).toStrictEqual({
      id: 'turn-taking-speakers',
      kind: 'code',
      version: '1.1.0',
      score: grader.score,
    })
    expect(TURN_TAKING_GRADER_ID).toBe('turn-taking-speakers')
    expect(TURN_TAKING_GRADER_VERSION).toBe('1.1.0')
    expect(METRIC_ACCEPTABLE_SPEAKER_RATE).toBe('turn_taking.acceptable_speaker_rate')
    expect(METRIC_REQUIRED_SPEAKER_RATE).toBe('turn_taking.required_speaker_rate')
    expect(METRIC_SILENCE_APPROPRIATE_RATE).toBe('turn_taking.silence_appropriate_rate')
  })

  it('reports a rate of zero when every labelled turn picked the wrong speaker', async () => {
    const strictGolden = {
      ...golden(),
      speakerLabels: (golden().speakerLabels ?? []).map((label) => ({
        ...label,
        allowUserYield: false,
      })),
    }
    const metrics = await createTurnTakingGrader().score({
      manifest: {} as never,
      trials: [trial({ records: [], golden: strictGolden })],
    })

    expect(metrics[METRIC_ACCEPTABLE_SPEAKER_RATE]).toBe(0)
  })

  it('reports a rate of one when every labelled turn is acceptable', async () => {
    const metrics = await createTurnTakingGrader().score({
      manifest: {} as never,
      trials: [
        trial({
          records: [
            record(0, 'user.utterance.committed', { text: 'a' }),
            granted('g0', 'peer'),
            record(2, 'user.utterance.committed', { text: 'b' }),
            granted('g1', 'manager'),
            record(4, 'user.utterance.committed', { text: 'c' }),
            granted('g2', 'manager'),
            record(6, 'user.utterance.committed', { text: 'd' }),
            granted('g3', 'manager'),
          ],
        }),
      ],
    })

    expect(metrics[METRIC_ACCEPTABLE_SPEAKER_RATE]).toBe(1)
  })

  it('keeps the deterministic invariant metrics alongside the turn rate', async () => {
    const metrics = await createTurnTakingGrader().score({
      manifest: {} as never,
      trials: [trial()],
    })

    expect(Object.keys(metrics)).toContain('replay.deterministic_rate')
    expect(Object.keys(metrics)).toContain('transcript.guard_violations')
    expect(METRIC_ACCEPTABLE_SPEAKER_RATE in metrics).toBe(true)
  })
})

describe('turn-taking invalid grants on a yield-allowed turn', () => {
  it.each([
    ['missing', undefined],
    ['an empty string', ''],
    ['a number', 42],
  ])('ignores a grant with %s persona id on a yield-allowed turn', (_label, personaId) => {
    const records = [
      record(0, 'user.utterance.committed', { text: 'a' }),
      record(1, 'user.utterance.committed', { text: 'b' }),
      record(2, 'user.utterance.committed', { text: 'c' }),
      record(3, 'turn.granted', {
        grant: {
          turnId: 'turn-1',
          grantId: 'g2',
          personaId,
          expiresAt: '2026-11-11T00:00:00.000Z',
        },
      }),
    ]

    expect(scoreTrialTurnTaking(trial({ records }))).toStrictEqual({ turns: 4, acceptable: 1 })
  })
})

function goldenWithLabels(labels: NonNullable<GoldenEntry['speakerLabels']>): GoldenEntry {
  return { ...golden(), speakerLabels: labels }
}

const silenceLabel = {
  acceptablePersonaIds: [],
  allowUserYield: true,
  labelSource: 'agent' as const,
}

describe('turn-taking label classes', () => {
  it('reports the required-speaker rate over speak-required turns only', () => {
    const classes = scoreTrialTurnClasses(trial())

    expect(classes).toStrictEqual({
      speak: { total: 3, appropriate: 2, rate: 2 / 3 },
      silence: { total: 0, appropriate: 0, rate: null },
      mixed: { total: 1 },
    })
    // The three class totals partition the same labelled turns the all-turn rate uses.
    expect(classes.speak.total + classes.silence.total + classes.mixed.total).toBe(
      scoreTrialTurnTaking(trial()).turns,
    )
  })

  it('reports the silence rate over silence-required turns only', () => {
    const records = [
      record(0, 'user.utterance.committed', { text: 'a' }),
      granted('g0', 'peer'),
      record(2, 'user.utterance.committed', { text: 'b' }),
      record(3, 'user.utterance.committed', { text: 'c' }),
    ]
    const silenceGolden = goldenWithLabels([
      { turnIndex: 0, ...silenceLabel },
      { turnIndex: 1, ...silenceLabel },
      { turnIndex: 2, ...silenceLabel },
    ])

    expect(scoreTrialTurnClasses(trial({ records, golden: silenceGolden }))).toStrictEqual({
      speak: { total: 0, appropriate: 0, rate: null },
      silence: { total: 3, appropriate: 2, rate: 2 / 3 },
      mixed: { total: 0 },
    })
  })

  it('counts a mixed label without rating it', () => {
    const mixedGolden = goldenWithLabels([
      { turnIndex: 0, acceptablePersonaIds: ['peer'], allowUserYield: true, labelSource: 'agent' },
    ])

    expect(scoreTrialTurnClasses(trial({ golden: mixedGolden }))).toStrictEqual({
      speak: { total: 0, appropriate: 0, rate: null },
      silence: { total: 0, appropriate: 0, rate: null },
      mixed: { total: 1 },
    })
  })

  it('accepts a speak-required turn when any granted persona is acceptable', () => {
    const records = [
      record(0, 'user.utterance.committed', { text: 'a' }),
      granted('g0', 'manager'),
      granted('g0b', 'peer'),
      record(3, 'user.utterance.committed', { text: 'b' }),
    ]
    const oneTurn = goldenWithLabels([
      { turnIndex: 0, acceptablePersonaIds: ['peer'], allowUserYield: false, labelSource: 'agent' },
    ])

    expect(scoreTrialTurnClasses(trial({ records, golden: oneTurn })).speak).toStrictEqual({
      total: 1,
      appropriate: 1,
      rate: 1,
    })
  })

  it('uses one label per turn when a golden repeats a turn index', () => {
    const repeated = goldenWithLabels([
      { turnIndex: 0, acceptablePersonaIds: ['peer'], allowUserYield: false, labelSource: 'agent' },
      { turnIndex: 0, acceptablePersonaIds: ['peer'], allowUserYield: false, labelSource: 'agent' },
    ])

    expect(scoreTrialTurnClasses(trial({ golden: repeated })).speak.total).toBe(1)
  })

  it('scores a label with no transcript record as a turn with no grants', () => {
    const missingRecord = goldenWithLabels([
      { turnIndex: 9, acceptablePersonaIds: ['peer'], allowUserYield: false, labelSource: 'agent' },
    ])

    expect(scoreTrialTurnClasses(trial({ golden: missingRecord })).speak).toStrictEqual({
      total: 1,
      appropriate: 0,
      rate: 0,
    })
  })

  it.each([
    ['a failed trial', { ok: false }],
    ['a single-persona task', { task: task(['manager']) }],
    ['missing speaker labels', { golden: { ...golden(), speakerLabels: undefined } }],
  ])('yields empty classes for %s', (_case, overrides) => {
    expect(scoreTrialTurnClasses(trial(overrides))).toStrictEqual({
      speak: { total: 0, appropriate: 0, rate: null },
      silence: { total: 0, appropriate: 0, rate: null },
      mixed: { total: 0 },
    })
  })
})

describe('turn-taking class metrics', () => {
  it('reports both class rates with the all-turn rate', async () => {
    const records = [
      record(0, 'user.utterance.committed', { text: 'a' }),
      granted('g0', 'peer'),
      record(2, 'user.utterance.committed', { text: 'b' }),
      record(3, 'user.utterance.committed', { text: 'c' }),
    ]
    const classesGolden = goldenWithLabels([
      { turnIndex: 0, acceptablePersonaIds: ['peer'], allowUserYield: false, labelSource: 'agent' },
      { turnIndex: 1, ...silenceLabel },
      {
        turnIndex: 2,
        acceptablePersonaIds: ['manager'],
        allowUserYield: false,
        labelSource: 'agent',
      },
    ])
    const metrics = await createTurnTakingGrader().score({
      manifest: {} as never,
      trials: [trial({ records, golden: classesGolden })],
    })

    expect(metrics[METRIC_REQUIRED_SPEAKER_RATE]).toBe(1 / 2)
    expect(metrics[METRIC_SILENCE_APPROPRIATE_RATE]).toBe(1)
    expect(metrics[METRIC_ACCEPTABLE_SPEAKER_RATE]).toBe(2 / 3)
  })

  it('omits an empty class rate rather than reporting zero', async () => {
    const silenceOnly = goldenWithLabels([
      { turnIndex: 0, ...silenceLabel },
      { turnIndex: 1, ...silenceLabel },
    ])
    const metrics = await createTurnTakingGrader().score({
      manifest: {} as never,
      trials: [trial({ records: [], golden: silenceOnly })],
    })

    expect(METRIC_REQUIRED_SPEAKER_RATE in metrics).toBe(false)
    expect(metrics[METRIC_SILENCE_APPROPRIATE_RATE]).toBe(1)
    expect(metrics[METRIC_ACCEPTABLE_SPEAKER_RATE]).toBe(1)
  })

  it('reports a class rate of zero when every turn in the class is wrong', async () => {
    const speakOnly = goldenWithLabels([
      { turnIndex: 0, acceptablePersonaIds: ['peer'], allowUserYield: false, labelSource: 'agent' },
      { turnIndex: 1, acceptablePersonaIds: ['peer'], allowUserYield: false, labelSource: 'agent' },
    ])
    const metrics = await createTurnTakingGrader().score({
      manifest: {} as never,
      trials: [trial({ records: [], golden: speakOnly })],
    })

    expect(metrics[METRIC_REQUIRED_SPEAKER_RATE]).toBe(0)
    expect(METRIC_SILENCE_APPROPRIATE_RATE in metrics).toBe(false)
  })
})
