import { parseRoutingContext, type RoutingContext } from '@rp/routing-policy'
import type { PersonaPolicyDecision, PersonaPolicyInput, TurnRequest } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import type {
  JevRoutingJudge,
  RoutingCentralObservation,
  RoutingJevResult,
} from '../jev/routing.js'
import { JevUnavailableError } from '../jev/errors.js'
import type { JevBatchSuccess } from '../jev/types.js'
import {
  createJevCentralLivePolicy,
  JEV_CENTRAL_LIVE_POLICY_ID,
  JEV_CENTRAL_LIVE_POLICY_VERSION,
  JEV_LIVE_DEFAULT_DEADLINE_MS,
  type JevLiveFailure,
} from './jev-live-policy.js'

const quiet = {
  closingMove: 0.1,
  selfAnswer: 0.1,
  thinkingAloud: 0.1,
  sideComment: 0.1,
}

function exact(answers: JevBatchSuccess['answers'], questionIds: string[]): JevBatchSuccess {
  const response = {
    model: 'typesafe/jev-1.14-20261014',
    answers,
    usage: { input_tokens: 10, output_tokens: 2 },
  }
  return {
    ok: true,
    questionIds,
    request: { model: 'typesafe/jev-1.14', state: {}, questions: {} },
    response,
    raw: response,
    answers,
    distributions: {},
    usage: response.usage,
    servedModel: response.model,
    cache: { key: 'a'.repeat(64), hit: false, stored: true },
  }
}

function observation(
  move: typeof quiet = quiet,
  selectedPersonaId?: string,
): RoutingCentralObservation {
  const answers = {
    closing_move: { type: 'noul' as const, noul: move.closingMove },
    self_answer: { type: 'noul' as const, noul: move.selfAnswer },
    thinking_aloud: { type: 'noul' as const, noul: move.thinkingAloud },
    side_comment: { type: 'noul' as const, noul: move.sideComment },
    ...(selectedPersonaId === undefined
      ? {}
      : {
          best_speaker: {
            type: 'choice' as const,
            choice: selectedPersonaId,
            probabilities: { manager: 0.6, peer: 0.4 },
          },
        }),
  }
  return {
    judgment: {
      move,
      ...(selectedPersonaId === undefined ? {} : { selectedPersonaId }),
    },
    exact: exact(answers, Object.keys(answers)),
  }
}

const uniqueOwners = [
  {
    topic: 'the handoff',
    keywords: ['handoff'],
    personaIds: ['peer'],
    source: 'objective' as const,
    objectiveId: 'handoff',
  },
]

const pairOwners = [
  {
    topic: 'the plan',
    keywords: ['plan'],
    personaIds: ['manager', 'peer'],
    source: 'fact' as const,
    sourceFactIndex: 0,
  },
]

function context(
  options: {
    lastUser?: string
    turnId?: string
    owners?: RoutingContext['owners']
  } = {},
): RoutingContext {
  return parseRoutingContext({
    decisionId: `decision-${options.turnId ?? 'turn-1'}`,
    turnId: options.turnId ?? 'turn-1',
    lang: 'en',
    coveredObjectiveIds: [],
    owners: options.owners ?? uniqueOwners,
    personas: [
      {
        id: 'manager',
        displayName: 'Katherine Brooks',
        aliases: ['Katherine'],
        role: 'manager',
        objectives: [{ id: 'deadline', description: 'Agree a deadline.', keywords: ['deadline'] }],
      },
      {
        id: 'peer',
        displayName: 'Sam Carter',
        aliases: ['Sam'],
        role: 'peer colleague',
        objectives: [{ id: 'handoff', description: 'Confirm handoff.', keywords: ['handoff'] }],
      },
    ],
    transcript: [
      { speaker: { kind: 'persona', personaId: 'manager' }, text: 'We need a date.' },
      {
        speaker: { kind: 'user' },
        text: options.lastUser ?? 'Sam, can you confirm the handoff?',
      },
    ],
  })
}

interface FakeJudge extends JevRoutingJudge {
  readonly calls: RoutingContext[]
}

const unexpectedPersona = async (): Promise<never> => {
  throw new Error('the central arm never asks for a persona judgment')
}

function judgeReturning(result: RoutingJevResult<RoutingCentralObservation>): FakeJudge {
  const calls: RoutingContext[] = []
  return {
    calls,
    async judgeCentral(input) {
      calls.push(input)
      return result
    },
    judgePersona: unexpectedPersona,
  }
}

function failingJudge(): FakeJudge {
  return judgeReturning({
    ok: false,
    error: new JevUnavailableError('down', { reason: 'network' }),
    questionIds: [],
  })
}

function fallbackRequestOf(input: PersonaPolicyInput<RoutingContext>): TurnRequest {
  return {
    turnId: input.turnId,
    personaId: input.personaId,
    action: 'speak',
    urgency: 1,
    confidence: 0.5,
    addressedByUser: false,
    objectiveRelevance: 1,
  }
}

const fallbackRequest = (input: PersonaPolicyInput<RoutingContext>): PersonaPolicyDecision => ({
  kind: 'request',
  request: fallbackRequestOf(input),
})

function input(
  personaId: string,
  turnId: string,
  routingContext: RoutingContext,
  action: 'speak' | 'interject' = 'speak',
): PersonaPolicyInput<RoutingContext> {
  return {
    personaId,
    turnId,
    action,
    ...(action === 'interject' ? { targetGrantId: 'grant-1' } : {}),
    messages: [],
    lang: 'en',
    context: routingContext,
  }
}

describe('createJevCentralLivePolicy', () => {
  it('runs one batch per turn and requests only the owner', async () => {
    const judge = judgeReturning({ ok: true, observation: observation() })
    const fallback = { decide: fallbackRequest }
    const policy = createJevCentralLivePolicy({ judge, fallback })
    const routingContext = context()

    const [manager, peer] = await Promise.all([
      policy.decide(input('manager', 'turn-1', routingContext)),
      policy.decide(input('peer', 'turn-1', routingContext)),
    ])

    expect(judge.calls).toHaveLength(1)
    expect(manager).toEqual({ kind: 'decline' })
    expect(peer).toMatchObject({
      kind: 'request',
      request: {
        turnId: 'turn-1',
        personaId: 'peer',
        action: 'speak',
        addressedByUser: true,
      },
    })
  })

  it('reuses the batch for later calls in the same turn', async () => {
    const judge = judgeReturning({ ok: true, observation: observation() })
    const policy = createJevCentralLivePolicy({ judge, fallback: { decide: fallbackRequest } })
    const routingContext = context()

    await policy.decide(input('peer', 'turn-1', routingContext))
    await policy.decide(input('peer', 'turn-1', routingContext))
    expect(judge.calls).toHaveLength(1)
  })

  it('runs a new batch on the next turn', async () => {
    const judge = judgeReturning({ ok: true, observation: observation() })
    const policy = createJevCentralLivePolicy({ judge, fallback: { decide: fallbackRequest } })

    await policy.decide(input('peer', 'turn-1', context({ turnId: 'turn-1' })))
    await policy.decide(input('peer', 'turn-2', context({ turnId: 'turn-2' })))
    expect(judge.calls.map((call) => call.turnId)).toEqual(['turn-1', 'turn-2'])
  })

  it('declines every persona when the move contract yields', async () => {
    const judge = judgeReturning({
      ok: true,
      observation: observation({ ...quiet, closingMove: 0.8 }),
    })
    const policy = createJevCentralLivePolicy({ judge, fallback: { decide: fallbackRequest } })
    const routingContext = context()

    const decisions = await Promise.all([
      policy.decide(input('manager', 'turn-1', routingContext)),
      policy.decide(input('peer', 'turn-1', routingContext)),
    ])
    expect(decisions).toEqual([{ kind: 'decline' }, { kind: 'decline' }])
  })

  it('uses the central Choice for a declared pair', async () => {
    const judge = judgeReturning({
      ok: true,
      observation: observation(quiet, 'manager'),
    })
    const policy = createJevCentralLivePolicy({ judge, fallback: { decide: fallbackRequest } })
    const routingContext = context({ lastUser: 'Who owns the plan?', owners: pairOwners })

    const [manager, peer] = await Promise.all([
      policy.decide(input('manager', 'turn-1', routingContext)),
      policy.decide(input('peer', 'turn-1', routingContext)),
    ])
    expect(manager).toMatchObject({ kind: 'request', request: { personaId: 'manager' } })
    expect(peer).toEqual({ kind: 'decline' })
  })

  it('falls back on a failed judge and reports once', async () => {
    const judge = failingJudge()
    const failures: JevLiveFailure[] = []
    const policy = createJevCentralLivePolicy({
      judge,
      fallback: { decide: fallbackRequest },
      onFailure: (failure) => failures.push(failure),
    })
    const routingContext = context()

    const decisions = await Promise.all([
      policy.decide(input('manager', 'turn-1', routingContext)),
      policy.decide(input('peer', 'turn-1', routingContext)),
    ])
    expect(failures).toEqual([{ turnId: 'turn-1', cause: 'error' }])
    expect(decisions).toEqual([
      {
        kind: 'request',
        request: fallbackRequestOf(input('manager', 'turn-1', routingContext)),
      },
      {
        kind: 'request',
        request: fallbackRequestOf(input('peer', 'turn-1', routingContext)),
      },
    ])
  })

  it('falls back on a timeout and reports it', async () => {
    const failures: JevLiveFailure[] = []
    const policy = createJevCentralLivePolicy({
      judge: {
        async judgeCentral() {
          await new Promise(() => {})
          throw new Error('unreachable')
        },
        judgePersona: unexpectedPersona,
      },
      fallback: { decide: fallbackRequest },
      deadlineMs: 5,
      onFailure: (failure) => failures.push(failure),
    })

    const decision = await policy.decide(input('peer', 'turn-1', context()))
    expect(failures).toEqual([{ turnId: 'turn-1', cause: 'timeout' }])
    expect(decision).toMatchObject({ kind: 'request' })
  })

  it('falls back when the judge throws', async () => {
    const failures: JevLiveFailure[] = []
    const policy = createJevCentralLivePolicy({
      judge: {
        async judgeCentral() {
          throw new Error('socket closed')
        },
        judgePersona: unexpectedPersona,
      },
      fallback: { decide: fallbackRequest },
      onFailure: (failure) => failures.push(failure),
    })

    const decision = await policy.decide(input('peer', 'turn-1', context()))
    expect(failures).toEqual([{ turnId: 'turn-1', cause: 'error' }])
    expect(decision).toMatchObject({ kind: 'request' })
  })

  it('does not pass the failure to the fallback as a decline', async () => {
    const judge = failingJudge()
    const answered: string[] = []
    const policy = createJevCentralLivePolicy({
      judge,
      fallback: {
        decide: (fallbackInput) => {
          answered.push(fallbackInput.personaId)
          return { kind: 'decline' }
        },
      },
    })

    expect(await policy.decide(input('peer', 'turn-1', context()))).toEqual({ kind: 'decline' })
    expect(answered).toEqual(['peer'])
  })

  it('delegates an interjection to the fallback without calling the model', async () => {
    const judge = judgeReturning({ ok: true, observation: observation() })
    const calls: string[] = []
    const policy = createJevCentralLivePolicy({
      judge,
      fallback: {
        decide: (fallbackInput) => {
          calls.push(fallbackInput.action)
          return { kind: 'decline' }
        },
      },
    })

    await policy.decide(input('peer', 'turn-1', context(), 'interject'))
    expect(judge.calls).toHaveLength(0)
    expect(calls).toEqual(['interject'])
  })

  it('names its policy and the evaluated arm version', () => {
    expect(JEV_CENTRAL_LIVE_POLICY_ID).toBe('jev-central')
    expect(JEV_CENTRAL_LIVE_POLICY_VERSION).toBe('m3d-jev-central-v2')
  })

  it('keeps a default deadline below the driver request window', () => {
    expect(JEV_LIVE_DEFAULT_DEADLINE_MS).toBe(1200)
  })

  it('answers when the judge is slower than one task tick but inside the default deadline', async () => {
    const failures: JevLiveFailure[] = []
    const policy = createJevCentralLivePolicy({
      judge: {
        async judgeCentral() {
          await new Promise((resolve) => setTimeout(resolve, 20))
          return { ok: true, observation: observation(quiet, 'peer') }
        },
        judgePersona: unexpectedPersona,
      },
      fallback: { decide: fallbackRequest },
      onFailure: (failure) => failures.push(failure),
    })

    const decision = await policy.decide(input('peer', 'turn-1', context()))
    expect(failures).toEqual([])
    expect(decision).toMatchObject({ kind: 'request', request: { personaId: 'peer' } })
  })
})
