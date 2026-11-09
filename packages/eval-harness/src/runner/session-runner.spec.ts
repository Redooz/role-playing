import { FakeClock } from '@rp/shared'
import { describe, expect, it } from 'vitest'
import type { CompletionProvider } from './canned-provider.js'
import { createCannedProvider } from './canned-provider.js'
import {
  PlainTextPolicyError,
  buildSessionCannedEntries,
  runSessionTask,
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

function run(task: TaskEntry, provider: CompletionProvider) {
  return runSessionTask({
    runId: 'm2-session',
    executionId: 'exec-1',
    task,
    clock: new FakeClock(0),
    provider,
    wallNow: () => 0,
    currentDate: DATE,
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
    expect(result.promptVersion).toBe('m2-prompt-gemma-v1')
  })
})
