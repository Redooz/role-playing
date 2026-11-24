import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { goldenEntrySchema, taskEntrySchema, type TaskEntry } from '../tasks/schema.js'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@rp/session-core'
import {
  CalibrationHistoryError,
  calibrationTasks,
  eventsFromTranscriptJsonl,
  sessionHistoryFromEvents,
} from './calibration-contexts.js'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const TASK_ID = 'en-b2-handover-en-v2-cal-001'
const TASK_PATH = join(
  REPO_ROOT,
  'evals/tasks/synthetic-multi-persona-session/m3b-v2/en',
  `${TASK_ID}.json`,
)
const GOLDEN_PATH = join(REPO_ROOT, 'evals/golden/en/m3b-v2', `${TASK_ID}.json`)

async function fixtures() {
  const task = taskEntrySchema.parse(JSON.parse(await readFile(TASK_PATH, 'utf8')))
  const golden = goldenEntrySchema.parse(JSON.parse(await readFile(GOLDEN_PATH, 'utf8')))
  return { task, golden }
}

function grantGranted(grantId: string, turnId: string, personaId: string): SessionEvent {
  return {
    type: 'turn.granted',
    payload: {
      grant: { grantId, turnId, personaId, expiresAt: '1970-01-01T00:01:00.000Z' },
    },
  }
}

/** One greeting plus four learner turns, each followed by a decision turn. */
function events(): SessionEvent[] {
  return [
    { type: 'session.started', payload: { sessionId: 's', clockMode: 'simulated', lang: 'en' } },
    { type: 'turn.opened', payload: { turnId: 'turn-1' } },
    grantGranted('g1', 'turn-1', 'manager'),
    { type: 'persona.response.committed', payload: { grantId: 'g1', text: 'Hello.' } },
    { type: 'user.utterance.committed', payload: { text: 'How do we keep the client informed?' } },
    { type: 'turn.opened', payload: { turnId: 'turn-2' } },
    grantGranted('g2', 'turn-2', 'peer'),
    {
      type: 'persona.response.committed',
      payload: { grantId: 'g2', text: 'Katherine owns that.' },
    },
    { type: 'user.utterance.committed', payload: { text: 'Who updates the client?' } },
    { type: 'turn.opened', payload: { turnId: 'turn-3' } },
    grantGranted('g3', 'turn-3', 'manager'),
    { type: 'persona.response.committed', payload: { grantId: 'g3', text: 'I will.' } },
    { type: 'user.utterance.committed', payload: { text: 'Katherine, what should I prepare?' } },
    { type: 'turn.opened', payload: { turnId: 'turn-4' } },
    grantGranted('g4', 'turn-4', 'peer'),
    { type: 'persona.response.committed', payload: { grantId: 'g4', text: 'Notes are mine.' } },
    { type: 'user.utterance.committed', payload: { text: 'Sam, what about the action list?' } },
    { type: 'turn.opened', payload: { turnId: 'turn-5' } },
  ]
}

function record(kind: string, payload: unknown, seq: number, contentClass = 'contentFree') {
  return {
    schemaVersion: '1.4.0',
    runId: 'run',
    executionId: 'normalized',
    seq,
    tSim: 0,
    tWall: 0,
    kind,
    payload,
    contentClass,
  }
}

describe('eventsFromTranscriptJsonl', () => {
  it('reads records in order and skips blank lines', () => {
    const text = [
      JSON.stringify(
        record('session.started', { sessionId: 's', clockMode: 'simulated', lang: 'en' }, 0),
      ),
      '',
      '   ',
      JSON.stringify(record('user.utterance.committed', { text: 'Hello.' }, 1, 'restricted')),
    ].join('\n')
    expect(eventsFromTranscriptJsonl(text)).toEqual([
      { type: 'session.started', payload: { sessionId: 's', clockMode: 'simulated', lang: 'en' } },
      { type: 'user.utterance.committed', payload: { text: 'Hello.' } },
    ])
  })

  it('drops a non-event record', () => {
    const text = JSON.stringify(record('latency.sample', { ms: 12 }, 0))
    expect(eventsFromTranscriptJsonl(text)).toEqual([])
  })

  it('rejects a malformed line instead of skipping it', () => {
    expect(() => eventsFromTranscriptJsonl('{"not":"a record"}')).toThrow()
  })
})

describe('sessionHistoryFromEvents', () => {
  it('reads committed turns in order and pairs each learner turn with its decision turn', () => {
    const history = sessionHistoryFromEvents(events())
    expect(history.turns.map((turn) => [turn.role, turn.personaId ?? null])).toStrictEqual([
      ['assistant', 'manager'],
      ['user', null],
      ['assistant', 'peer'],
      ['user', null],
      ['assistant', 'manager'],
      ['user', null],
      ['assistant', 'peer'],
      ['user', null],
    ])
    expect(history.decisionTurnIds).toEqual(['turn-2', 'turn-3', 'turn-4', 'turn-5'])
  })

  it('keeps a persona turn without a matched grant minimal', () => {
    const history = sessionHistoryFromEvents([
      { type: 'persona.response.committed', payload: { grantId: 'ghost', text: 'Boo.' } },
    ])
    expect(history.turns[0]).toStrictEqual({
      role: 'assistant',
      content: 'Boo.',
      personaId: undefined,
    })
  })

  it('drops the greeting opening and keeps later openings in order', () => {
    const history = sessionHistoryFromEvents([
      { type: 'turn.opened', payload: { turnId: 'turn-1' } },
      { type: 'user.utterance.committed', payload: { text: 'One.' } },
      { type: 'turn.opened', payload: { turnId: 'turn-2' } },
    ])
    expect(history.decisionTurnIds).toEqual(['turn-2'])
  })

  it('drops a learner turn with no following turn instead of inventing one', () => {
    const history = sessionHistoryFromEvents([
      { type: 'user.utterance.committed', payload: { text: 'Nobody answers.' } },
    ])
    expect(history.turns).toHaveLength(1)
    expect(history.decisionTurnIds).toEqual([])
  })
})

describe('CalibrationHistoryError', () => {
  it('keeps its name and message', () => {
    const error = new CalibrationHistoryError('history is wrong')
    expect(error.name).toBe('CalibrationHistoryError')
    expect(error.message).toBe('history is wrong')
  })
})

describe('calibrationTasks', () => {
  it('builds one labelled context per learner turn with public ownership', async () => {
    const { task, golden } = await fixtures()
    const tasks = calibrationTasks(task, golden, sessionHistoryFromEvents(events()))

    expect(tasks.map((entry) => entry.taskId)).toEqual([
      `${TASK_ID}:turn-2`,
      `${TASK_ID}:turn-3`,
      `${TASK_ID}:turn-4`,
      `${TASK_ID}:turn-5`,
    ])
    expect(tasks.every((entry) => entry.lang === 'en')).toBe(true)
    for (const entry of tasks) {
      expect(entry.context.owners.length).toBeGreaterThan(0)
      expect(entry.context.transcript.at(-1)?.speaker.kind).toBe('user')
    }
    expect(tasks[0]?.label).toStrictEqual({
      intent: 'post-demo-handover',
      acceptablePersonaIds: ['manager'],
      allowUserYield: false,
      labelSource: 'agent',
      family: 'TT-S5',
    })
  })

  it('puts the round in the task id so multi-round trials stay apart', async () => {
    const { task, golden } = await fixtures()
    const history = sessionHistoryFromEvents(events())
    const first = calibrationTasks(task, golden, history, { round: 0 })
    const second = calibrationTasks(task, golden, history, { round: 2 })
    expect(first[0]?.taskId).toBe(`${TASK_ID}#r0:turn-2`)
    expect(second[0]?.taskId).toBe(`${TASK_ID}#r2:turn-2`)
    expect(first[0]?.context.turnId).toBe(second[0]?.context.turnId)
    expect(new Set([...first, ...second].map((entry) => entry.taskId)).size).toBe(8)
  })

  it('grows the context as the conversation grows and names each persona turn', async () => {
    const { task, golden } = await fixtures()
    const tasks = calibrationTasks(task, golden, sessionHistoryFromEvents(events()))
    expect(tasks.map((entry) => entry.context.transcript.length)).toEqual([2, 4, 6, 8])
    expect(tasks[0]?.context.transcript[0]).toEqual({
      speaker: { kind: 'persona', personaId: 'manager' },
      text: 'Hello.',
    })
    expect(tasks[0]?.context.transcript[1]?.speaker).toEqual({ kind: 'user' })
  })

  it('keeps a distractor flag and names a missing family', async () => {
    const { task, golden } = await fixtures()
    const labels = golden.speakerLabels!.map((label, index) => ({
      ...label,
      ...(index === 0 ? { distractor: true } : {}),
      ...(index === 1 ? { family: undefined } : {}),
    }))
    const tasks = calibrationTasks(
      task,
      { ...golden, speakerLabels: labels },
      sessionHistoryFromEvents(events()),
    )
    expect(tasks[0]?.label).toMatchObject({ distractor: true })
    expect(tasks[1]?.label).toMatchObject({ family: 'unlabelled' })
    expect(tasks[2]?.label).not.toHaveProperty('distractor')
  })

  it('falls back to the language when the task has no locale', async () => {
    const { task, golden } = await fixtures()
    const withoutLocale = { ...task, locale: undefined } as unknown as TaskEntry
    const tasks = calibrationTasks(withoutLocale, golden, sessionHistoryFromEvents(events()))
    expect(tasks).toHaveLength(4)
    expect(tasks[0]?.context.lang).toBe('en')
  })

  it('rejects a task that is not a session task', async () => {
    const { task, golden } = await fixtures()
    const withoutSession = { ...task, session: undefined } as unknown as TaskEntry
    expect(() =>
      calibrationTasks(withoutSession, golden, sessionHistoryFromEvents(events())),
    ).toThrow(/not a session task/u)
  })

  it('rejects a single-persona session task', async () => {
    const { task, golden } = await fixtures()
    const single = {
      ...task,
      session: { ...task.session!, personaIds: undefined },
    } as unknown as TaskEntry
    expect(() => calibrationTasks(single, golden, sessionHistoryFromEvents(events()))).toThrow(
      /multi-persona/u,
    )
    const empty = {
      ...task,
      session: { ...task.session!, personaIds: [] },
    } as unknown as TaskEntry
    expect(() => calibrationTasks(empty, golden, sessionHistoryFromEvents(events()))).toThrow(
      /multi-persona/u,
    )
  })

  it('rejects a label count that does not match the learner turns', async () => {
    const { task, golden } = await fixtures()
    const history = sessionHistoryFromEvents(events())
    expect(() =>
      calibrationTasks(
        task,
        { ...golden, speakerLabels: golden.speakerLabels?.slice(0, 2) },
        history,
      ),
    ).toThrow(/2 labels for 4 learner turns/u)
  })

  it('rejects a history with a learner turn that has no decision turn', async () => {
    const { task, golden } = await fixtures()
    const history = sessionHistoryFromEvents([
      ...events(),
      { type: 'user.utterance.committed', payload: { text: 'One more.' } },
    ])
    expect(() => calibrationTasks(task, golden, history)).toThrow(/5 learner turns but 4/u)
  })

  it('rejects a golden with no speaker labels', async () => {
    const { task, golden } = await fixtures()
    expect(() =>
      calibrationTasks(
        task,
        { ...golden, speakerLabels: undefined },
        sessionHistoryFromEvents(events()),
      ),
    ).toThrow(/no speaker labels/u)
    expect(() =>
      calibrationTasks(task, { ...golden, speakerLabels: [] }, sessionHistoryFromEvents(events())),
    ).toThrow(/no speaker labels/u)
  })
})
