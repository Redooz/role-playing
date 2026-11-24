/**
 * Shared builders for the session runner specs.
 *
 * Test-only: one scripted single-persona task, one two-persona task and the fake
 * providers/judge the session specs drive them with. Excluded from mutation
 * (`*.fixtures.ts`), like the routing-policy and turn-arbiter fixtures.
 */
import { FakeClock } from '@rp/shared'
import type { JevRoutingJudge } from '../jev/routing.js'
import type { CompletionProvider } from './canned-provider.js'
import { runSessionTask, type SessionPromptMode } from './session-runner.js'
import type { TaskEntry } from '../tasks/schema.js'

export const DATE = '2026-11-08'

export function sessionTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
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

export function textProvider(text: string): CompletionProvider {
  return {
    kind: 'live',
    label: 'fake-live',
    async *complete() {
      yield { text, done: false }
      yield { text: '', done: true }
    },
  }
}

export function run(task: TaskEntry, provider: CompletionProvider, promptMode?: SessionPromptMode) {
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

export function multiPersonaTask(): TaskEntry {
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

export function personaAwareProvider(requests: string[][]): CompletionProvider {
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

export function shadowJudge(): JevRoutingJudge {
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
          judgment: {
            move: { closingMove: 0.1, selfAnswer: 0.1, thinkingAloud: 0.1, sideComment: 0.1 },
            selectedPersonaId: 'manager',
          },
          exact,
        },
      }
    },
    async judgePersona() {
      return {
        ok: true as const,
        observation: {
          judgments: {
            closingMove: 0.1,
            selfAnswer: 0.1,
            thinkingAloud: 0.1,
            sideComment: 0.1,
            directlyAddressed: 0,
          },
          exact,
        },
      }
    },
  }
}
