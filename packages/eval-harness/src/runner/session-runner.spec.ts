import { FakeClock } from '@rp/shared'
import { describe, expect, it } from 'vitest'
import type { JevRoutingJudge } from '../jev/routing.js'
import type { CompletionProvider } from './canned-provider.js'
import { createCannedProvider } from './canned-provider.js'
import {
  PlainTextPolicyError,
  buildSessionCannedEntries,
  runSessionTask,
  type SessionPromptMode,
} from './session-runner.js'
import type { TaskEntry } from '../tasks/schema.js'

const DATE = '2026-11-08'

function sessionTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: 'en-session-deadline-001',
    lang: 'en',
    locale: 'en',
    mode: 'session',
    domain: 'workplace',
    scenarioType: 'request-deadline-extension',
    cefrBand: 'B1',
    speakerId: 'speaker-session-en-01',
    split: 'calibration',
    provenance: { source: 'synthetic' },
    consentScope: 'synthetic-no-consent-required',
    annotationVersions: { rubric: 'v2' },
    content: { scenarioBrief: 'A junior analyst asks for more time.', turns: [] },
    session: {
      personaId: 'manager',
      personaVersion: '1.0.0',
      scenarioId: 'request-deadline-extension',
      scenarioVersion: '1.0.0',
      scriptedUserTurns: ['I need two more days.', 'Would Monday afternoon work?'],
      recordedPersonaTurns: [
        'Morning. How is the report going?',
        'What is still missing?',
        'Monday works.',
      ],
    },
    ...overrides,
  } as TaskEntry
}

function textProvider(text: string): CompletionProvider {
  return {
    kind: 'live',
    label: 'fake-live',
    async *complete() {
      yield { text, done: false }
      yield { text: '', done: true }
    },
  }
}

function run(task: TaskEntry, provider: CompletionProvider, promptMode?: SessionPromptMode) {
  return runSessionTask({
    runId: 'm2-session',
    executionId: 'exec-1',
    task,
    clock: new FakeClock(0),
    provider,
    wallNow: () => 0,
    currentDate: DATE,
    promptMode,
  })
}

describe('session runner', () => {
  it('greets first, then sends every scripted learner turn', async () => {
    const requests: string[][] = []
    const provider: CompletionProvider = {
      kind: 'live',
      label: 'capture',
      async *complete(request) {
        requests.push(request.messages.map((message) => `${message.role}:${message.content}`))
        yield { text: 'Okay.', done: false }
        yield { text: '', done: true }
      },
    }

    const result = await run(sessionTask(), provider)

    expect(requests).toHaveLength(3)
    expect(requests[0]?.[0]).toContain('## Opening')
    expect(requests[0]?.[0]).not.toContain('## Goals')
    expect(requests[1]?.[0]).toContain('## Goals')
    expect(requests[1]?.[1]).toBe('assistant:Okay.')
    expect(requests[1]?.[2]).toBe('user:I need two more days.')

    const committed = result.records
      .filter((record) => record.kind === 'persona.response.committed')
      .map((record) => (record.payload as { text: string }).text)
    expect(committed).toEqual(['Okay.', 'Okay.', 'Okay.'])
    expect(result.records.at(-1)?.kind).toBe('session.completed')
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('cleans Markdown and emoji before the transcript sees them', async () => {
    const result = await run(sessionTask(), textProvider('**Hello** there 😀. Next.'))
    const committed = result.records
      .filter((record) => record.kind === 'persona.response.committed')
      .map((record) => (record.payload as { text: string }).text)

    expect(committed).toEqual(['Hello there. Next.', 'Hello there. Next.', 'Hello there. Next.'])
  })

  it('rejects an empty reply after filtering', async () => {
    await expect(run(sessionTask(), textProvider('😀🎉'))).rejects.toBeInstanceOf(
      PlainTextPolicyError,
    )
  })

  it('turns a provider failure into an infrastructure error, not a pass', async () => {
    const provider: CompletionProvider = {
      kind: 'live',
      label: 'failing',
      complete() {
        throw new Error('provider down')
      },
    }
    await expect(run(sessionTask(), provider)).rejects.toMatchObject({
      name: 'ProviderUnavailableError',
    })
  })

  it('replays a canned session by the full request hash', async () => {
    const task = sessionTask()
    const entries = buildSessionCannedEntries(task, DATE)
    const provider = createCannedProvider(entries, 'canned-session')
    const result = await run(task, provider)

    const committed = result.records
      .filter((record) => record.kind === 'persona.response.committed')
      .map((record) => (record.payload as { text: string }).text)
    expect(committed).toEqual(task.session?.recordedPersonaTurns)
  })

  it('replays a canned generic session by the full request hash', async () => {
    const task = sessionTask()
    const entries = buildSessionCannedEntries(task, DATE, 'harmony', 'generic')
    const provider = createCannedProvider(entries, 'canned-session')
    const result = await run(task, provider, 'generic')

    const committed = result.records
      .filter((record) => record.kind === 'persona.response.committed')
      .map((record) => (record.payload as { text: string }).text)
    expect(committed).toEqual(task.session?.recordedPersonaTurns)
  })

  it('rejects a persona recording when the run asks for generic', async () => {
    const task = sessionTask()
    const entries = buildSessionCannedEntries(task, DATE)
    const provider = createCannedProvider(entries, 'canned-session')

    await expect(run(task, provider, 'generic')).rejects.toBeInstanceOf(Error)
  })

  it('invalidates a canned recording when the locale changes', async () => {
    const entries = buildSessionCannedEntries(sessionTask(), DATE)
    const localised = sessionTask({ locale: 'en-GB', id: 'en-gb-session-deadline-001' })
    const provider = createCannedProvider(entries, 'canned-session')

    await expect(run(localised, provider)).rejects.toBeInstanceOf(Error)
  })

  it('builds the Gemma pack when the run asks for it', async () => {
    const requests: string[] = []
    const provider: CompletionProvider = {
      kind: 'live',
      label: 'capture',
      async *complete(request) {
        requests.push(request.messages[0]?.content ?? '')
        yield { text: 'Okay.', done: false }
        yield { text: '', done: true }
      },
    }

    const result = await runSessionTask({
      runId: 'm2-session',
      executionId: 'exec-1',
      task: sessionTask(),
      clock: new FakeClock(0),
      provider,
      wallNow: () => 0,
      currentDate: DATE,
      promptStyle: 'gemma',
    })

    expect(requests[0]).toContain('HOW TO REPLY')
    expect(requests[0]).not.toContain('You are ChatGPT')
    expect(result.promptVersion).toBe('m2-prompt-gemma-v2')
  })
})

function multiPersonaTask(): TaskEntry {
  return sessionTask({
    id: 'en-multi-scope-001',
    scenarioType: 'standup-scope-change',
    content: { scenarioBrief: 'The manager changes the release scope at stand-up.', turns: [] },
    session: {
      personaId: 'manager',
      personaIds: ['manager', 'peer'],
      personaVersion: '1.0.0',
      scenarioId: 'standup-scope-change',
      scenarioVersion: '1.0.0',
      scriptedUserTurns: [
        'Sam, how much of the notification work is finished?',
        'Katherine, what ships on Friday?',
      ],
    },
  })
}

function personaAwareProvider(requests: string[][]): CompletionProvider {
  return {
    kind: 'live',
    label: 'fake-multi',
    async *complete(request) {
      const system = request.messages.find((message) => message.role === 'system')?.content ?? ''
      requests.push(request.messages.map((message) => `${message.role}:${message.content}`))
      yield {
        text: system.includes('Sam Carter') ? 'Peer reply.' : 'Manager reply.',
        done: false,
      }
      yield { text: '', done: true }
    },
  }
}

describe('multi-persona session runner', () => {
  it('runs two personas with one prompt each and labels the grants', async () => {
    const requests: string[][] = []
    const result = await run(multiPersonaTask(), personaAwareProvider(requests))

    expect(result.personaPrompts.map((entry) => entry.personaId)).toEqual(['manager', 'peer'])
    expect(new Set(result.personaPrompts.map((entry) => entry.promptHash)).size).toBe(2)
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/)

    const grants = result.records
      .filter((record) => record.kind === 'turn.granted')
      .map((record) => (record.payload as { grant: { personaId: string } }).grant.personaId)
    expect(grants[0]).toBe('manager')
    expect(grants).toContain('peer')
    expect(grants).toContain('manager')

    const committed = result.records.filter(
      (record) => record.kind === 'persona.response.committed',
    )
    expect(committed.length).toBeGreaterThanOrEqual(2)
    expect(
      result.records.filter((record) => record.kind === 'user.utterance.committed'),
    ).toHaveLength(2)
    expect(requests.length).toBeGreaterThanOrEqual(2)
  })

  it('refuses the generic baseline for a multi-persona task', async () => {
    await expect(run(multiPersonaTask(), textProvider('Okay.'), 'generic')).rejects.toThrow(
      /generic baseline supports one/u,
    )
  })

  it('refuses a canned replay for a multi-persona task', () => {
    expect(() => buildSessionCannedEntries(multiPersonaTask(), DATE)).toThrow(
      /does not support multi-persona/u,
    )
  })
})

function shadowJudge(): JevRoutingJudge {
  const exact = {
    ok: true as const,
    questionIds: [],
    request: { model: 'typesafe/jev-1.14', state: {}, questions: {} },
    response: {
      model: 'typesafe/jev-1.14-20261014',
      answers: {},
      usage: { input_tokens: 10, output_tokens: 2, cost: 0.0001 },
    },
    raw: {},
    answers: {},
    distributions: {},
    usage: { input_tokens: 10, output_tokens: 2, cost: 0.0001 },
    servedModel: 'typesafe/jev-1.14-20261014',
    cache: { key: 'a'.repeat(64), hit: false, stored: true },
  }
  return {
    async judgeCentral() {
      return {
        ok: true as const,
        observation: {
          judgment: { anyoneWarranted: 0.9, selectedPersonaId: 'manager' },
          exact,
        },
      }
    },
    async judgePersona() {
      return {
        ok: true as const,
        observation: {
          judgments: {
            directlyAddressed: 0,
            hasRelevantContribution: 0,
            addsUncoveredInformation: 0,
            hasUnmetRelevantObjective: 0,
            pauseWouldBenefitUser: 1,
          },
          exact,
        },
      }
    },
  }
}

describe('multi-persona shadow switch', () => {
  it('records every non-live arm after each scripted turn without changing events', async () => {
    const requests: string[][] = []
    const result = await runSessionTask({
      runId: 'm3b-shadow',
      executionId: 'exec-shadow',
      task: multiPersonaTask(),
      clock: new FakeClock(0),
      provider: personaAwareProvider(requests),
      wallNow: () => 0,
      currentDate: DATE,
      shadow: { judge: shadowJudge(), seed: 7, deadlineMs: 1000 },
    })

    expect(result.shadow?.records).toHaveLength(6)
    expect(result.shadow?.summary).toMatchObject({
      kind: 'routing.shadow.summary',
      taskId: 'en-multi-scope-001',
      records: 6,
    })
    expect(result.records.filter((record) => record.kind === 'session.started')).toHaveLength(1)
  })

  it('refuses shadow on a single-persona task', async () => {
    await expect(
      runSessionTask({
        runId: 'm3b-shadow',
        executionId: 'exec-shadow',
        task: sessionTask(),
        clock: new FakeClock(0),
        provider: textProvider('Okay.'),
        wallNow: () => 0,
        currentDate: DATE,
        shadow: { judge: shadowJudge(), seed: 7, deadlineMs: 1000 },
      }),
    ).rejects.toThrow(/shadow arms require a multi-persona task/u)
  })
})
