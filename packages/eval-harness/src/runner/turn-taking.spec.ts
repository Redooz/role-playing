import { TRANSCRIPT_SCHEMA_VERSION, type TranscriptRecord } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import type { GoldenEntry, TaskEntry } from '../tasks/schema.js'
import {
  TURN_TAKING_GRADER_ID,
  createTurnTakingGrader,
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
  it('counts a turn acceptable when any grant is in the label set', () => {
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
