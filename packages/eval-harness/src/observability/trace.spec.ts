import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRANSCRIPT_SCHEMA_VERSION, type TranscriptRecord } from '@rp/session-core'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildGrades } from './grades.js'
import { buildObservationPlan, type ObservationPlan } from './plan.js'
import { ObservationPlanError, buildTrace } from './trace.js'
import { executeRun, type EvaluationRun } from '../runner/runner.js'
import type { TaskEntry } from '../tasks/schema.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const manifestPath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')

const fixedWallClock = (): number => 1_700_000_000_000
const targetTask = 'en-b1-report-deadline-001'

function loadManifestRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
}

function loadTask(id: string, lang: 'en' | 'fr'): { content: { turns: { text: string }[] } } {
  return JSON.parse(
    readFileSync(join(repoRoot, `evals/tasks/synthetic-workplace/v1/${lang}/${id}.json`), 'utf8'),
  ) as { content: { turns: { text: string }[] } }
}

describe('buildTrace', () => {
  let execution: EvaluationRun
  let plan: ObservationPlan

  beforeEach(async () => {
    execution = await executeRun({
      repoRoot,
      manifest: loadManifestRaw(),
      wallClock: fixedWallClock,
    })
    const grades = [...buildGrades({ execution }).records]
    plan = buildObservationPlan({ execution, grades })
  })

  it('maps a session transcript without replay turns', async () => {
    const sessionManifest = JSON.parse(
      readFileSync(join(repoRoot, 'evals/manifests/m2-persona-replay-v2.json'), 'utf8'),
    ) as Record<string, unknown>
    const sessionExecution = await executeRun({
      repoRoot,
      manifest: sessionManifest,
      wallClock: fixedWallClock,
    })
    const sessionGrades = buildGrades({ execution: sessionExecution }).records
    const sessionPlan = buildObservationPlan({
      execution: sessionExecution,
      grades: sessionGrades,
    })

    expect(sessionPlan.items).toHaveLength(12)
    const item = sessionPlan.items[0]
    expect(item?.itemId).toMatch(/^0:(en|fr):/)
    expect(item?.input.turns.length).toBeGreaterThan(0)
    expect(item?.input.turns.every((turn) => turn.role === 'user')).toBe(true)
    expect(item?.output.conversation).toBeDefined()
    expect(item?.output.conversation?.length).toBeGreaterThan(1)
    expect(item?.output.conversation?.[0]?.role).toBe('persona')
    expect(item?.output.transcript).toContain('Persona:')
    expect(item?.output.transcript).toContain('Learner:')
    const personaSpans = item?.trace.spans.filter((span) => span.name.includes(' persona')) ?? []
    const userSpans = item?.trace.spans.filter((span) => span.name.includes(' user')) ?? []
    expect(personaSpans).toHaveLength(userSpans.length + 1)
    expect(
      item?.trace.spans
        .filter((span) => span.type === 'generation')
        .every((span) => span.model === 'm2-persona-canned-v1'),
    ).toBe(true)
  })

  it('builds turn spans and provider generations from the transcript', () => {
    const item = plan.items.find((candidate) => candidate.itemId === `0:en:${targetTask}`)
    expect(item).toBeDefined()

    expect(item?.input.scenarioBrief).toContain('junior analyst')
    expect(item?.input.turns).toHaveLength(5)

    const spans = item?.trace.spans ?? []
    expect(spans.filter((span) => span.type === 'generation')).toHaveLength(3)
    expect(spans.filter((span) => span.name.includes(' user'))).toHaveLength(2)
    expect(spans.filter((span) => span.name.includes(' persona'))).toHaveLength(3)
    expect(spans).toHaveLength(8)

    const generations = spans.filter((span) => span.type === 'generation')
    expect(generations.map((span) => span.parentId)).toEqual([
      'turn-0-persona',
      'turn-2-persona',
      'turn-4-persona',
    ])
    expect(generations.map((span) => span.model)).toEqual([
      'canned/persona-v1',
      'canned/persona-v1',
      'canned/persona-v1',
    ])

    const task = loadTask(targetTask, 'en')
    expect(generations.at(-1)?.output).toBe(task.content.turns.at(-1)?.text)
    expect(item?.output.status).toBe('completed')
    expect(item?.output.finalText).toBe(task.content.turns.at(-1)?.text)

    // First persona turn has no prior messages; the last has four.
    const inputSizes = generations.map((span) =>
      Array.isArray(span.input) ? span.input.length : -1,
    )
    expect(inputSizes).toEqual([0, 2, 4])
  })

  it('records grants and closes persona spans on a committed response', () => {
    const item = plan.items.find((candidate) => candidate.itemId === `0:en:${targetTask}`)
    const personaSpans = (item?.trace.spans ?? []).filter((span) => span.name.includes(' persona'))
    expect(personaSpans).toHaveLength(3)

    for (const span of personaSpans) {
      expect(span.events.map((event) => event.name)).toEqual(['turn.granted'])
      expect(span.endMs).toBeGreaterThanOrEqual(span.startMs)
    }

    expect(item?.trace.events.map((event) => event.name)).toEqual(['session.completed'])
  })
})

interface TurnLiteral {
  readonly role: 'user' | 'persona'
  readonly text: string
}

const expiresAt = '2026-01-01T00:00:00.000Z'

const taskBase = {
  lang: 'en',
  domain: 'synthetic-workplace',
  scenarioType: 'status-update',
  cefrBand: 'B1',
  speakerId: 'learner-1',
  split: 'calibration',
  provenance: { source: 'synthetic', generator: 'trace.spec', version: 'v1' },
  consentScope: 'synthetic-no-consent-required',
  annotationVersions: { rubric: 'v1' },
}

function makeTask(
  mode: 'replay' | 'session',
  turns: readonly TurnLiteral[],
  id = 'replay-task',
): TaskEntry {
  return { ...taskBase, id, mode, content: { turns } } as unknown as TaskEntry
}

let nextSeq = 0

function rec(kind: string, tSim: number, payload: unknown = {}): TranscriptRecord {
  nextSeq += 1
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    runId: 'trace-run',
    seq: nextSeq,
    tSim,
    tWall: 1_700_000_000_000 + tSim,
    kind,
    payload,
    contentClass: 'restricted',
  }
}

function captureError(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the call to throw')
}

describe('buildTrace fold', () => {
  beforeEach(() => {
    nextSeq = 0
  })

  it('folds a session task with generated turns and the session provider labels', () => {
    const trace = buildTrace(
      makeTask('session', [], 'session-task'),
      [
        rec('turn.granted', 0, {
          grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
        }),
        rec('persona.response.started', 2, { grantId: 'g-1' }),
        rec('persona.response.chunk', 3, { grantId: 'g-1', text: 'Hi ', sequence: 0 }),
        rec('persona.response.committed', 10, { grantId: 'g-1', text: 'Hi there.' }),
        rec('user.utterance.committed', 20, { text: 'Hello.' }),
        rec('session.completed', 30),
      ],
      'livekit-inference',
    )

    expect(trace.spans.map((span) => span.id)).toStrictEqual([
      'turn-0-persona',
      'generation-0',
      'turn-1-user',
    ])
    expect(trace.spans[0]).toStrictEqual({
      id: 'turn-0-persona',
      name: 'turn 0 persona',
      type: 'span',
      startMs: 0,
      endMs: 30,
      metadata: { turnId: 'turn-0', personaId: 'manager', provider: 'livekit-inference' },
      events: [
        {
          name: 'turn.granted',
          atMs: 0,
          attributes: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
        },
      ],
    })
    expect(trace.spans[1]).toStrictEqual({
      id: 'generation-0',
      parentId: 'turn-0-persona',
      name: 'persona response 0',
      type: 'generation',
      startMs: 2,
      endMs: 10,
      input: [],
      output: 'Hi there.',
      model: 'livekit-inference',
      metadata: { provider: 'livekit-inference', grantId: 'g-1' },
      events: [],
    })
    expect(trace.spans[2]).toStrictEqual({
      id: 'turn-1-user',
      name: 'turn 1 user',
      type: 'span',
      startMs: 20,
      endMs: 20,
      input: 'Hello.',
      output: 'Hello.',
      events: [],
    })
    expect(trace.finalText).toBe('Hi there.')
    expect(trace.conversation).toStrictEqual([
      { index: 0, role: 'persona', text: 'Hi there.' },
      { index: 1, role: 'user', text: 'Hello.' },
    ])
    expect(trace.events).toStrictEqual([{ name: 'session.completed', atMs: 30, attributes: {} }])
  })

  it('maps replay turns to their recorded roles and labels with the replay provider', () => {
    const task = makeTask('replay', [
      { role: 'persona', text: 'Welcome back.' },
      { role: 'user', text: 'I need the report by Friday.' },
      { role: 'persona', text: 'Understood.' },
      { role: 'user', text: 'Can you check the numbers?' },
      { role: 'persona', text: 'I checked them.' },
    ])
    const trace = buildTrace(
      task,
      [
        rec('user.utterance.committed', 10, { text: 'I need the report by Friday.' }),
        rec('turn.granted', 20, {
          grant: { grantId: 'g-1', turnId: 'turn-1', personaId: 'manager', expiresAt },
        }),
        rec('persona.response.started', 22, { grantId: 'g-1' }),
        rec('persona.response.chunk', 24, { grantId: 'g-1', text: 'Under', sequence: 0 }),
        rec('persona.response.chunk', 25, { grantId: 'g-1', text: 'stood.', sequence: 1 }),
        rec('persona.response.committed', 30, { grantId: 'g-1', text: 'Understood.' }),
        rec('user.utterance.committed', 35, { text: 'Can you check the numbers?' }),
        rec('turn.granted', 40, {
          grant: { grantId: 'g-2', turnId: 'turn-2', personaId: 'manager', expiresAt },
        }),
        rec('persona.response.started', 42, { grantId: 'g-2' }),
        rec('persona.response.committed', 50, { grantId: 'g-2', text: 'I checked them.' }),
        rec('session.completed', 60),
      ],
      'unused-session-provider',
    )

    expect(trace.spans).toStrictEqual([
      {
        id: 'turn-1-user',
        name: 'turn 1 user',
        type: 'span',
        startMs: 10,
        endMs: 10,
        input: 'I need the report by Friday.',
        output: 'I need the report by Friday.',
        events: [],
      },
      {
        id: 'turn-2-persona',
        name: 'turn 2 persona',
        type: 'span',
        startMs: 20,
        endMs: 60,
        metadata: { turnId: 'turn-1', personaId: 'manager', provider: 'persona' },
        events: [
          {
            name: 'turn.granted',
            atMs: 20,
            attributes: { grantId: 'g-1', turnId: 'turn-1', personaId: 'manager', expiresAt },
          },
        ],
      },
      {
        id: 'generation-2',
        parentId: 'turn-2-persona',
        name: 'persona response 2',
        type: 'generation',
        startMs: 22,
        endMs: 30,
        input: [
          { role: 'assistant', content: 'Welcome back.' },
          { role: 'user', content: 'I need the report by Friday.' },
        ],
        output: 'Understood.',
        model: 'canned/persona-v1',
        metadata: { provider: 'persona', grantId: 'g-1' },
        events: [],
      },
      {
        id: 'turn-3-user',
        name: 'turn 3 user',
        type: 'span',
        startMs: 35,
        endMs: 35,
        input: 'Can you check the numbers?',
        output: 'Can you check the numbers?',
        events: [],
      },
      {
        id: 'turn-4-persona',
        name: 'turn 4 persona',
        type: 'span',
        startMs: 40,
        endMs: 60,
        metadata: { turnId: 'turn-2', personaId: 'manager', provider: 'persona' },
        events: [
          {
            name: 'turn.granted',
            atMs: 40,
            attributes: { grantId: 'g-2', turnId: 'turn-2', personaId: 'manager', expiresAt },
          },
        ],
      },
      {
        id: 'generation-4',
        parentId: 'turn-4-persona',
        name: 'persona response 4',
        type: 'generation',
        startMs: 42,
        endMs: 50,
        input: [
          { role: 'assistant', content: 'Welcome back.' },
          { role: 'user', content: 'I need the report by Friday.' },
          { role: 'assistant', content: 'Understood.' },
          { role: 'user', content: 'Can you check the numbers?' },
        ],
        output: 'I checked them.',
        model: 'canned/persona-v1',
        metadata: { provider: 'persona', grantId: 'g-2' },
        events: [],
      },
    ])
    expect(trace.finalText).toBe('I checked them.')
    expect(trace.conversation).toStrictEqual([
      { index: 0, role: 'user', text: 'I need the report by Friday.' },
      { index: 1, role: 'persona', text: 'Understood.' },
      { index: 2, role: 'user', text: 'Can you check the numbers?' },
      { index: 3, role: 'persona', text: 'I checked them.' },
    ])
    expect(trace.events.map((event) => event.name)).toStrictEqual(['session.completed'])
  })

  it('rejects a user event that the replay task does not contain', () => {
    const error = captureError(() =>
      buildTrace(
        makeTask('replay', [{ role: 'persona', text: 'Welcome.' }]),
        [rec('user.utterance.committed', 10, { text: 'Hello.' })],
        'provider',
      ),
    )

    expect(error).toBeInstanceOf(ObservationPlanError)
    expect(error.name).toBe('ObservationPlanError')
    expect(error.message).toBe(
      'transcript has a user event that the task replay-task does not contain',
    )
  })

  it('rejects a persona event that the replay task does not contain', () => {
    const error = captureError(() =>
      buildTrace(
        makeTask('replay', [{ role: 'user', text: 'Hello.' }]),
        [
          rec('turn.granted', 10, {
            grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
          }),
        ],
        'provider',
      ),
    )

    expect(error).toBeInstanceOf(ObservationPlanError)
    expect(error.message).toBe(
      'transcript has a persona event that the task replay-task does not contain',
    )
  })

  it('closes a grant left open at the last transcript timestamp', () => {
    const trace = buildTrace(
      makeTask('replay', [
        { role: 'persona', text: 'Welcome.' },
        { role: 'user', text: 'Yes.' },
      ]),
      [
        rec('turn.granted', 20, {
          grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
        }),
        rec('user.utterance.committed', 30, { text: 'Yes.' }),
        rec('session.completed', 40),
      ],
      'provider',
    )

    expect(trace.spans.map((span) => [span.id, span.startMs, span.endMs])).toStrictEqual([
      ['turn-0-persona', 20, 40],
      ['turn-1-user', 30, 30],
    ])
    expect(trace.spans.some((span) => span.type === 'generation')).toBe(false)
    expect(Object.keys(trace)).toStrictEqual(['events', 'spans', 'conversation'])
  })

  it('keeps a closed span end at or after its start', () => {
    const trace = buildTrace(
      makeTask('replay', [
        { role: 'persona', text: 'Welcome.' },
        { role: 'user', text: 'Yes.' },
      ]),
      [
        rec('turn.granted', 20, {
          grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
        }),
        rec('user.utterance.committed', 10, { text: 'Yes.' }),
      ],
      'provider',
    )

    expect(trace.spans.map((span) => [span.id, span.startMs, span.endMs])).toStrictEqual([
      ['turn-0-persona', 20, 20],
      ['turn-1-user', 10, 10],
    ])
  })

  it('ignores persona events that arrive before a grant', () => {
    const trace = buildTrace(
      makeTask('replay', [{ role: 'persona', text: 'Welcome.' }]),
      [
        rec('persona.response.started', 5, { grantId: 'g-1' }),
        rec('persona.response.chunk', 6, { grantId: 'g-1', text: 'lost', sequence: 0 }),
        rec('persona.response.committed', 7, { grantId: 'g-1', text: 'lost' }),
        rec('persona.response.cancelled', 8, { grantId: 'g-1', reason: 'timeout' }),
        rec('turn.granted', 20, {
          grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
        }),
        rec('session.completed', 30),
      ],
      'provider',
    )

    expect(trace.spans.map((span) => span.id)).toStrictEqual(['turn-0-persona'])
    expect(trace.spans[0]?.endMs).toBe(30)
    expect(trace.conversation).toStrictEqual([])
    expect(Object.keys(trace)).toStrictEqual(['events', 'spans', 'conversation'])
  })

  it('starts a committed generation at the commit time when no start was observed', () => {
    const trace = buildTrace(
      makeTask('replay', [
        { role: 'persona', text: 'Welcome.' },
        { role: 'user', text: 'Yes.' },
      ]),
      [
        rec('turn.granted', 20, {
          grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
        }),
        rec('persona.response.committed', 30, { grantId: 'g-1', text: 'Good.' }),
        rec('user.utterance.committed', 40, { text: 'Yes.' }),
      ],
      'provider',
    )

    expect(trace.spans).toStrictEqual([
      {
        id: 'turn-0-persona',
        name: 'turn 0 persona',
        type: 'span',
        startMs: 20,
        endMs: 40,
        metadata: { turnId: 'turn-0', personaId: 'manager', provider: 'persona' },
        events: [
          {
            name: 'turn.granted',
            atMs: 20,
            attributes: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
          },
        ],
      },
      {
        id: 'generation-0',
        parentId: 'turn-0-persona',
        name: 'persona response 0',
        type: 'generation',
        startMs: 30,
        endMs: 30,
        input: [],
        output: 'Good.',
        model: 'canned/persona-v1',
        metadata: { provider: 'persona', grantId: 'g-1' },
        events: [],
      },
      {
        id: 'turn-1-user',
        name: 'turn 1 user',
        type: 'span',
        startMs: 40,
        endMs: 40,
        input: 'Yes.',
        output: 'Yes.',
        events: [],
      },
    ])
    expect(trace.finalText).toBe('Good.')
  })

  it('resets the persona state after a committed response', () => {
    const trace = buildTrace(
      makeTask('replay', [{ role: 'persona', text: 'Welcome.' }]),
      [
        rec('turn.granted', 20, {
          grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
        }),
        rec('persona.response.committed', 30, { grantId: 'g-1', text: 'First.' }),
        rec('persona.response.started', 31, { grantId: 'g-1' }),
        rec('persona.response.chunk', 32, { grantId: 'g-1', text: 'stale', sequence: 0 }),
        rec('persona.response.committed', 33, { grantId: 'g-1', text: 'Second.' }),
        rec('session.completed', 40),
      ],
      'provider',
    )

    expect(trace.spans.map((span) => span.id)).toStrictEqual(['turn-0-persona', 'generation-0'])
    expect(trace.spans[1]?.output).toBe('First.')
    expect(trace.finalText).toBe('First.')
    expect(trace.conversation).toStrictEqual([{ index: 0, role: 'persona', text: 'First.' }])
  })

  it('records a cancellation with the partial text and closes the turn span', () => {
    const trace = buildTrace(
      makeTask('replay', [
        { role: 'persona', text: 'Welcome.' },
        { role: 'user', text: 'Anything else?' },
      ]),
      [
        rec('turn.granted', 20, {
          grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
        }),
        rec('persona.response.started', 22, { grantId: 'g-1' }),
        rec('persona.response.chunk', 24, { grantId: 'g-1', text: 'Half a', sequence: 0 }),
        rec('persona.response.chunk', 25, { grantId: 'g-1', text: ' sentence', sequence: 1 }),
        rec('persona.response.cancelled', 30, { grantId: 'g-1', reason: 'user_barge_in' }),
        rec('persona.response.chunk', 35, { grantId: 'g-1', text: 'late', sequence: 2 }),
        rec('persona.response.cancelled', 36, { grantId: 'g-1', reason: 'timeout' }),
        rec('user.utterance.committed', 40, { text: 'Anything else?' }),
        rec('session.completed', 50),
      ],
      'provider',
    )

    expect(trace.spans).toStrictEqual([
      {
        id: 'turn-0-persona',
        name: 'turn 0 persona',
        type: 'span',
        startMs: 20,
        endMs: 50,
        metadata: { turnId: 'turn-0', personaId: 'manager', provider: 'persona' },
        events: [
          {
            name: 'turn.granted',
            atMs: 20,
            attributes: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
          },
          {
            name: 'persona.response.cancelled',
            atMs: 30,
            attributes: { grantId: 'g-1', reason: 'user_barge_in' },
          },
        ],
      },
      {
        id: 'generation-0',
        parentId: 'turn-0-persona',
        name: 'persona response 0 (cancelled)',
        type: 'generation',
        startMs: 22,
        endMs: 30,
        input: [],
        output: 'Half a sentence',
        model: 'canned/persona-v1',
        metadata: { provider: 'persona', grantId: 'g-1', cancelled: true },
        events: [],
      },
      {
        id: 'turn-1-user',
        name: 'turn 1 user',
        type: 'span',
        startMs: 40,
        endMs: 40,
        input: 'Anything else?',
        output: 'Anything else?',
        events: [],
      },
    ])
    expect(trace.finalText).toBeUndefined()
    expect(trace.conversation).toStrictEqual([{ index: 0, role: 'user', text: 'Anything else?' }])
  })

  it('omits the output of a cancellation with no partial text and defaults the reason', () => {
    const trace = buildTrace(
      makeTask('replay', [{ role: 'persona', text: 'Welcome.' }]),
      [
        rec('turn.granted', 20, {
          grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
        }),
        rec('persona.response.cancelled', 30, {}),
      ],
      'provider',
    )

    expect(trace.spans[1]).toStrictEqual({
      id: 'generation-0',
      parentId: 'turn-0-persona',
      name: 'persona response 0 (cancelled)',
      type: 'generation',
      startMs: 30,
      endMs: 30,
      input: [],
      model: 'canned/persona-v1',
      metadata: { provider: 'persona', grantId: 'g-1', cancelled: true },
      events: [],
    })
    expect(trace.spans[0]?.events.at(-1)?.attributes).toStrictEqual({
      grantId: 'g-1',
      reason: 'unknown',
    })
  })

  it('reads a cancellation reason only from a string field', () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [{ reason: 'interrupted' }, 'interrupted'],
      [{ reason: 42 }, 'unknown'],
      [{}, 'unknown'],
      [null, 'unknown'],
      ['plain', 'unknown'],
      [7, 'unknown'],
    ]

    for (const [payload, expected] of cases) {
      const trace = buildTrace(
        makeTask('replay', [{ role: 'persona', text: 'Welcome.' }]),
        [
          rec('turn.granted', 20, {
            grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
          }),
          rec('persona.response.cancelled', 30, payload),
        ],
        'provider',
      )

      expect(trace.spans[0]?.events.at(-1)?.name).toBe('persona.response.cancelled')
      expect(trace.spans[0]?.events.at(-1)?.attributes['reason']).toBe(expected)
    }
  })

  it('closes the granted turn span on a revocation by grant id', () => {
    const trace = buildTrace(
      makeTask('replay', [
        { role: 'persona', text: 'Welcome.' },
        { role: 'user', text: 'Yes.' },
      ]),
      [
        rec('turn.granted', 20, {
          grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
        }),
        rec('turn.revoked', 30, { grantId: 'g-1', reason: 'timeout' }),
        rec('user.utterance.committed', 40, { text: 'Yes.' }),
        rec('session.completed', 50),
      ],
      'provider',
    )

    expect(trace.spans).toStrictEqual([
      {
        id: 'turn-0-persona',
        name: 'turn 0 persona',
        type: 'span',
        startMs: 20,
        endMs: 30,
        metadata: { turnId: 'turn-0', personaId: 'manager', provider: 'persona' },
        events: [
          {
            name: 'turn.granted',
            atMs: 20,
            attributes: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
          },
          {
            name: 'turn.revoked',
            atMs: 30,
            attributes: { grantId: 'g-1', reason: 'timeout' },
          },
        ],
      },
      {
        id: 'turn-1-user',
        name: 'turn 1 user',
        type: 'span',
        startMs: 40,
        endMs: 40,
        input: 'Yes.',
        output: 'Yes.',
        events: [],
      },
    ])
    expect(trace.conversation).toStrictEqual([{ index: 0, role: 'user', text: 'Yes.' }])
  })

  it('falls back to the open persona when a revocation names an unknown grant', () => {
    const trace = buildTrace(
      makeTask('replay', [
        { role: 'persona', text: 'Welcome.' },
        { role: 'user', text: 'Yes.' },
      ]),
      [
        rec('turn.granted', 20, {
          grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
        }),
        rec('turn.revoked', 30, { grantId: 'g-9', reason: 'interrupted' }),
        rec('persona.response.chunk', 35, { grantId: 'g-1', text: 'late', sequence: 0 }),
        rec('persona.response.started', 36, { grantId: 'g-1' }),
        rec('persona.response.committed', 37, { grantId: 'g-1', text: 'late' }),
        rec('user.utterance.committed', 40, { text: 'Yes.' }),
      ],
      'provider',
    )

    expect(trace.spans.map((span) => span.id)).toStrictEqual(['turn-0-persona', 'turn-1-user'])
    expect(trace.spans[0]).toStrictEqual({
      id: 'turn-0-persona',
      name: 'turn 0 persona',
      type: 'span',
      startMs: 20,
      endMs: 30,
      metadata: { turnId: 'turn-0', personaId: 'manager', provider: 'persona' },
      events: [
        {
          name: 'turn.granted',
          atMs: 20,
          attributes: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
        },
        {
          name: 'turn.revoked',
          atMs: 30,
          attributes: { grantId: 'g-1', reason: 'interrupted' },
        },
      ],
    })
  })

  it('revokes a known grant that is not the current persona grant', () => {
    const trace = buildTrace(
      makeTask('replay', [
        { role: 'persona', text: 'Welcome.' },
        { role: 'user', text: 'First.' },
        { role: 'persona', text: 'Second.' },
        { role: 'user', text: 'Yes.' },
      ]),
      [
        rec('turn.granted', 10, {
          grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
        }),
        rec('persona.response.committed', 20, { grantId: 'g-1', text: 'First.' }),
        rec('user.utterance.committed', 25, { text: 'First.' }),
        rec('turn.granted', 30, {
          grant: { grantId: 'g-2', turnId: 'turn-2', personaId: 'manager', expiresAt },
        }),
        rec('turn.revoked', 40, { grantId: 'g-1', reason: 'completed' }),
        rec('session.completed', 50),
      ],
      'provider',
    )

    expect(trace.spans).toStrictEqual([
      {
        id: 'turn-0-persona',
        name: 'turn 0 persona',
        type: 'span',
        startMs: 10,
        endMs: 40,
        metadata: { turnId: 'turn-0', personaId: 'manager', provider: 'persona' },
        events: [
          {
            name: 'turn.granted',
            atMs: 10,
            attributes: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
          },
          {
            name: 'turn.revoked',
            atMs: 40,
            attributes: { grantId: 'g-1', reason: 'completed' },
          },
        ],
      },
      {
        id: 'generation-0',
        parentId: 'turn-0-persona',
        name: 'persona response 0',
        type: 'generation',
        startMs: 20,
        endMs: 20,
        input: [],
        output: 'First.',
        model: 'canned/persona-v1',
        metadata: { provider: 'persona', grantId: 'g-1' },
        events: [],
      },
      {
        id: 'turn-1-user',
        name: 'turn 1 user',
        type: 'span',
        startMs: 25,
        endMs: 25,
        input: 'First.',
        output: 'First.',
        events: [],
      },
      {
        id: 'turn-2-persona',
        name: 'turn 2 persona',
        type: 'span',
        startMs: 30,
        endMs: 50,
        metadata: { turnId: 'turn-2', personaId: 'manager', provider: 'persona' },
        events: [
          {
            name: 'turn.granted',
            atMs: 30,
            attributes: { grantId: 'g-2', turnId: 'turn-2', personaId: 'manager', expiresAt },
          },
        ],
      },
    ])
    expect(trace.conversation).toStrictEqual([
      { index: 0, role: 'persona', text: 'First.' },
      { index: 1, role: 'user', text: 'First.' },
    ])
  })

  it('treats a revocation with nothing open as a no-op', () => {
    const trace = buildTrace(
      makeTask('replay', [{ role: 'persona', text: 'Welcome.' }]),
      [
        rec('turn.revoked', 10, {}),
        rec('turn.revoked', 11, { grantId: 'g-9', reason: 'cancelled' }),
        rec('session.completed', 20),
      ],
      'provider',
    )

    expect(trace).toStrictEqual({
      events: [{ name: 'session.completed', atMs: 20, attributes: {} }],
      spans: [],
      conversation: [],
    })
  })

  it('treats a non-string revoked grant id as unknown', () => {
    const trace = buildTrace(
      makeTask('replay', [{ role: 'persona', text: 'Welcome.' }]),
      [
        rec('turn.granted', 20, {
          grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
        }),
        rec('turn.revoked', 30, { grantId: 42, reason: 'completed' }),
      ],
      'provider',
    )

    expect(trace.spans[0]?.endMs).toBe(30)
    expect(trace.spans[0]?.events.at(-1)?.attributes).toStrictEqual({
      grantId: 'g-1',
      reason: 'completed',
    })
  })

  it('ignores record kinds it does not fold', () => {
    const trace = buildTrace(
      makeTask('replay', [{ role: 'persona', text: 'Welcome.' }]),
      [
        rec('turn.granted', 20, {
          grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt },
        }),
        rec('latency.sample', 25, { text: 'ignore me' }),
        rec('turn.opened', 26, { turnId: 'turn-0' }),
        rec('mystery.kind', 27, null),
        rec('session.completed', 30),
      ],
      'provider',
    )

    expect(trace.spans.map((span) => span.id)).toStrictEqual(['turn-0-persona'])
    expect(trace.events).toStrictEqual([{ name: 'session.completed', atMs: 30, attributes: {} }])
  })

  it('rejects a text payload without a string text field', () => {
    const task = makeTask('replay', [{ role: 'user', text: 'Hello.' }])
    const payloads: readonly unknown[] = ['plain', null, {}, { text: 7 }, []]

    for (const payload of payloads) {
      const error = captureError(() =>
        buildTrace(task, [rec('user.utterance.committed', 5, payload)], 'provider'),
      )
      expect(error).toBeInstanceOf(ObservationPlanError)
      expect(error.name).toBe('ObservationPlanError')
      expect(error.message).toBe('transcript payload has no text field')
    }
  })

  it('rejects a grant payload without a complete grant', () => {
    const task = makeTask('replay', [{ role: 'persona', text: 'Welcome.' }])
    const payloads: readonly unknown[] = [
      'plain',
      7,
      null,
      {},
      { grant: null },
      { grant: 'nope' },
      { grant: { turnId: 'turn-0', personaId: 'manager', expiresAt } },
      { grant: { grantId: 'g-1', personaId: 'manager', expiresAt } },
      { grant: { grantId: 'g-1', turnId: 'turn-0', expiresAt } },
      { grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager' } },
      { grant: { grantId: 1, turnId: 'turn-0', personaId: 'manager', expiresAt } },
      { grant: { grantId: 'g-1', turnId: 1, personaId: 'manager', expiresAt } },
      { grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 1, expiresAt } },
      { grant: { grantId: 'g-1', turnId: 'turn-0', personaId: 'manager', expiresAt: 1 } },
    ]

    for (const payload of payloads) {
      const error = captureError(() =>
        buildTrace(task, [rec('turn.granted', 20, payload)], 'provider'),
      )
      expect(error).toBeInstanceOf(ObservationPlanError)
      expect(error.message).toBe('turn.granted payload has no complete grant')
    }
  })

  it('returns an empty fold for an empty transcript', () => {
    const trace = buildTrace(
      makeTask('replay', [{ role: 'persona', text: 'Welcome.' }]),
      [],
      'provider',
    )

    expect(trace).toStrictEqual({ events: [], spans: [], conversation: [] })
  })
})
