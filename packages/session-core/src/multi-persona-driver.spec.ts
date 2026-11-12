import { FakeClock } from '@rp/shared'
import { describe, expect, it, vi } from 'vitest'
import type {
  ConversationMessage,
  PersonaPolicyInput,
  PersonaTurnPolicy,
  SessionArbiterEffect,
  SessionArbiterInput,
  SessionArbiterPort,
} from './arbiter-port.js'
import { createTextSessionDriver } from './driver.js'
import { MultiPersonaSessionDriver } from './multi-persona-driver.js'
import type {
  EventPayloadFor,
  SessionEvent,
  SessionEventName,
  TextModelUsage,
  TurnRequest,
} from './events.js'
import { guardTurnEvents } from './guards.js'
import type { TextModelChunk, TextModelPort, TextModelRequest } from './model-port.js'

/**
 * Driver mechanics against a scripted arbiter.
 *
 * The real reducer is exercised in `@rp/turn-arbiter`'s
 * `driver-integration.spec.ts`; here the point is the seam: effects become
 * events, only the granted persona streams, and revocation wins over late
 * output. Keeping the arbiter scripted also keeps this suite independent of
 * ranking rules.
 */

interface TestContext {
  readonly turnId: string
}

type TestState =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'window'
      readonly turnId: string
      readonly eligible: readonly string[]
      readonly requests: readonly TurnRequest[]
      readonly answered: readonly string[]
      readonly failed: readonly string[]
    }
  | {
      readonly phase: 'grant'
      readonly turnId: string
      readonly grantId: string
      readonly personaId: string
      readonly lastSequence: number
      readonly expiresAtMs: number
    }
  | { readonly phase: 'ended' }

function emit<Name extends SessionEventName>(
  type: Name,
  payload: EventPayloadFor<Name>,
): SessionArbiterEffect {
  return { kind: 'emit_event', type, payload } as SessionArbiterEffect
}

function scriptedArbiter(
  inputs: SessionArbiterInput<TestContext>[] = [],
): SessionArbiterPort<TestState, TestContext> {
  let grants = 0

  const nextGrant = (
    turnId: string,
    personaId: string,
    nowMs: number,
  ): Extract<TestState, { phase: 'grant' }> => {
    grants += 1
    return {
      phase: 'grant',
      turnId,
      grantId: `test:${turnId}:${grants}`,
      personaId,
      lastSequence: -1,
      expiresAtMs: nowMs + 60_000,
    }
  }

  const grantEffects = (
    state: Extract<TestState, { phase: 'grant' }>,
    nowMs: number,
  ): SessionArbiterEffect[] => [
    emit('turn.granted', {
      grant: {
        turnId: state.turnId,
        grantId: state.grantId,
        personaId: state.personaId,
        expiresAt: new Date(nowMs + 60_000).toISOString(),
      },
    }),
    { kind: 'start_generation', grantId: state.grantId, personaId: state.personaId },
  ]

  const settleWindow = (
    state: Extract<TestState, { phase: 'window' }>,
    nowMs: number,
  ): { state: TestState; effects: SessionArbiterEffect[] } => {
    const answered = new Set([
      ...state.answered,
      ...state.failed,
      ...state.requests.map((request) => request.personaId),
    ])
    if (state.eligible.some((personaId) => !answered.has(personaId))) {
      return { state, effects: [] }
    }
    const winner = state.requests[0]
    if (winner === undefined) {
      return {
        state: { phase: 'idle' },
        effects: [
          emit('turn.user_yielded', {
            reason: state.failed.length > 0 ? 'policy_timeout' : 'all_declined',
          }),
        ],
      }
    }
    const next = nextGrant(state.turnId, winner.personaId, nowMs)
    return { state: next, effects: grantEffects(next, nowMs) }
  }

  return {
    initialState: { phase: 'idle' },
    reduce(state, input) {
      inputs.push(input)
      switch (input.kind) {
        case 'user_committed': {
          if (state.phase !== 'idle') return { state, effects: [] }
          return {
            state: {
              phase: 'window',
              turnId: input.turnId,
              eligible: input.eligiblePersonaIds,
              requests: [],
              answered: [],
              failed: [],
            },
            effects: [emit('turn.opened', { turnId: input.turnId })],
          }
        }
        case 'request': {
          const request = input.request
          if (request.action === 'interject') {
            if (state.phase !== 'grant') return { state, effects: [] }
            if (request.targetGrantId !== state.grantId) return { state, effects: [] }
            if (request.personaId === state.personaId) return { state, effects: [] }
            const next = nextGrant(state.turnId, request.personaId, input.nowMs)
            return {
              state: next,
              effects: [
                emit('persona.requested_turn', { request }),
                emit('turn.revoked', { grantId: state.grantId, reason: 'interrupted' }),
                { kind: 'cancel_generation', grantId: state.grantId, reason: 'interrupted' },
                ...grantEffects(next, input.nowMs),
              ],
            }
          }
          if (state.phase !== 'window' || request.turnId !== state.turnId) {
            return { state, effects: [] }
          }
          const next = { ...state, requests: [...state.requests, request] }
          const settled = settleWindow(next, input.nowMs)
          return {
            state: settled.state,
            effects: [emit('persona.requested_turn', { request }), ...settled.effects],
          }
        }
        case 'declined': {
          if (state.phase !== 'window' || input.turnId !== state.turnId) {
            return { state, effects: [] }
          }
          const next = { ...state, answered: [...state.answered, input.personaId] }
          const settled = settleWindow(next, input.nowMs)
          return {
            state: settled.state,
            effects: [
              emit('persona.declined', { turnId: input.turnId, personaId: input.personaId }),
              ...settled.effects,
            ],
          }
        }
        case 'policy_failed': {
          if (state.phase !== 'window' || input.turnId !== state.turnId) {
            return { state, effects: [] }
          }
          const next = { ...state, failed: [...state.failed, input.personaId] }
          return settleWindow(next, input.nowMs)
        }
        case 'partial': {
          if (state.phase !== 'grant' || input.grantId !== state.grantId) {
            return { state, effects: [] }
          }
          if (input.sequence <= state.lastSequence) return { state, effects: [] }
          return {
            state: { ...state, lastSequence: input.sequence },
            effects: [
              emit('persona.utterance.partial', {
                grantId: state.grantId,
                text: input.text,
                sequence: input.sequence,
              }),
            ],
          }
        }
        case 'user_barge_in': {
          if (state.phase === 'grant') {
            return {
              state: { phase: 'idle' },
              effects: [
                emit('user.barge_in', { targetGrantId: state.grantId }),
                emit('turn.revoked', { grantId: state.grantId, reason: 'user_barge_in' }),
                { kind: 'cancel_generation', grantId: state.grantId, reason: 'user_barge_in' },
              ],
            }
          }
          if (state.phase === 'window') {
            return { state: { phase: 'idle' }, effects: [emit('user.barge_in', {})] }
          }
          return { state, effects: [] }
        }
        case 'tick': {
          if (state.phase === 'grant' && input.nowMs >= state.expiresAtMs) {
            return {
              state: { phase: 'idle' },
              effects: [
                emit('turn.revoked', { grantId: state.grantId, reason: 'timeout' }),
                { kind: 'cancel_generation', grantId: state.grantId, reason: 'timeout' },
              ],
            }
          }
          return { state, effects: [] }
        }
        case 'response_ended': {
          if (state.phase !== 'grant' || input.grantId !== state.grantId) {
            return { state, effects: [] }
          }
          const reason = input.outcome === 'failed' ? 'provider_failure' : 'completed'
          return {
            state: { phase: 'idle' },
            effects: [emit('turn.revoked', { grantId: state.grantId, reason })],
          }
        }
        case 'close': {
          if (state.phase === 'ended') return { state, effects: [] }
          const revoked =
            state.phase === 'grant'
              ? [
                  emit('turn.revoked', {
                    grantId: state.grantId,
                    reason: 'session_completed' as const,
                  }),
                ]
              : []
          return {
            state: { phase: 'ended' },
            effects: [...revoked, emit('session.completed', {}), { kind: 'close_session' }],
          }
        }
      }
    },
  }
}

interface ScriptedModel extends TextModelPort {
  readonly requests: TextModelRequest[]
}

function scriptedModel(
  chunks: readonly string[],
  options: {
    readonly beforeChunk?: (index: number) => void
    readonly fail?: boolean
    readonly lateChunk?: boolean
    readonly usage?: TextModelUsage
    readonly delayMs?: number
  } = {},
): ScriptedModel {
  const requests: TextModelRequest[] = []
  return {
    kind: 'canned',
    label: 'scripted',
    requests,
    async *complete(request: TextModelRequest): AsyncIterable<TextModelChunk> {
      requests.push(request)
      if (options.fail === true) throw new Error('provider failed')
      for (const [index, text] of chunks.entries()) {
        options.beforeChunk?.(index)
        if (options.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs))
        }
        await Promise.resolve()
        const last = index === chunks.length - 1
        yield {
          text,
          done: last,
          ...(last && options.usage !== undefined ? { usage: options.usage } : {}),
        }
      }
      if (options.lateChunk === true) {
        await Promise.resolve()
        yield { text: 'late', done: true }
      }
    },
  }
}

function speakRequest(turnId: string, personaId: string): TurnRequest {
  return {
    turnId,
    personaId,
    action: 'speak',
    urgency: 0,
    confidence: 1,
    addressedByUser: false,
    objectiveRelevance: 0,
  }
}

function interjectRequest(turnId: string, personaId: string, grantId: string): TurnRequest {
  return { ...speakRequest(turnId, personaId), action: 'interject', targetGrantId: grantId }
}

interface Harness {
  readonly events: SessionEvent[]
  onEvent(listener: (event: SessionEvent) => void): void
  finished(): Promise<void>
}

function openMulti(
  options: {
    readonly models: readonly [string, TextModelPort][]
    readonly policy: PersonaTurnPolicy<TestContext>
    readonly requestWindowMs?: number
    readonly maxHistoryMessages?: number
    readonly messagesSeen?: ConversationMessage[][]
    readonly arbiterInputs?: SessionArbiterInput<TestContext>[]
    readonly seedSource?: () => number
    readonly locale?: string
    readonly clockMode?: 'simulated' | 'wall'
    readonly taskId?: string
    readonly arbiter?: SessionArbiterPort<TestState, TestContext>
  },
  clock = new FakeClock(0),
): { driver: ReturnType<typeof createTextSessionDriver>; harness: Harness } {
  const driver = createTextSessionDriver({
    sessionId: 'multi-1',
    lang: 'en',
    clockMode: 'simulated',
    clock,
    personas: options.models.map(([personaId, model]) => ({ personaId, model })),
    arbiter: options.arbiter ?? scriptedArbiter(options.arbiterInputs),
    policy: options.policy,
    buildContext: (input) => {
      options.messagesSeen?.push([...input.messages])
      return { turnId: input.turnId }
    },
    ...(options.seedSource === undefined
      ? { seedSource: () => 7 }
      : { seedSource: options.seedSource }),
    ...(options.requestWindowMs === undefined ? {} : { requestWindowMs: options.requestWindowMs }),
    ...(options.maxHistoryMessages === undefined
      ? {}
      : { maxHistoryMessages: options.maxHistoryMessages }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    ...(options.clockMode === undefined ? {} : { clockMode: options.clockMode }),
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
  })

  const events: SessionEvent[] = []
  let listener: ((event: SessionEvent) => void) | undefined
  const consumer = (async () => {
    for await (const event of driver.events) {
      events.push(event)
      listener?.(event)
    }
  })()

  return {
    driver,
    harness: {
      events,
      onEvent(next) {
        listener = next
      },
      finished: () => consumer,
    },
  }
}

async function runToEnd(
  driver: ReturnType<typeof createTextSessionDriver>,
  harness: Harness,
): Promise<SessionEvent[]> {
  await driver.close()
  await harness.finished()
  return harness.events
}

function types(events: readonly SessionEvent[]): string[] {
  return events.map((event) => event.type)
}

describe('multi-persona session driver', () => {
  it('rejects options that mix single- and multi-persona configuration', () => {
    expect(() =>
      createTextSessionDriver({
        sessionId: 's',
        lang: 'en',
        clock: new FakeClock(0),
        model: scriptedModel(['x']),
        personaId: 'manager',
        personas: [{ personaId: 'manager', model: scriptedModel(['x']) }],
        arbiter: scriptedArbiter(),
        policy: { decide: () => ({ kind: 'decline' }) },
        buildContext: () => ({ turnId: 't' }),
      }),
    ).toThrow(/personaId is for single-persona mode/)
  })

  it('requires an arbiter, a policy and a context builder', () => {
    const base = {
      sessionId: 's',
      lang: 'en' as const,
      clock: new FakeClock(0),
      personas: [{ personaId: 'manager', model: scriptedModel(['x']) }],
    }
    expect(() => createTextSessionDriver({ ...base })).toThrow(/require an arbiter and a policy/)
    expect(() =>
      createTextSessionDriver({
        ...base,
        arbiter: scriptedArbiter(),
        policy: { decide: () => ({ kind: 'decline' }) },
      }),
    ).toThrow(/require a buildContext function/)
  })

  it('rejects duplicate and empty persona ids', () => {
    const base = {
      sessionId: 's',
      lang: 'en' as const,
      clock: new FakeClock(0),
      arbiter: scriptedArbiter(),
      policy: { decide: () => ({ kind: 'decline' as const }) },
      buildContext: () => ({ turnId: 't' }),
    }
    expect(() =>
      createTextSessionDriver({
        ...base,
        personas: [
          { personaId: 'manager', model: scriptedModel(['x']) },
          { personaId: 'manager', model: scriptedModel(['y']) },
        ],
      }),
    ).toThrow(/duplicate persona id/)
    expect(() =>
      createTextSessionDriver({
        ...base,
        personas: [{ personaId: ' ', model: scriptedModel(['x']) }],
      }),
    ).toThrow(/must not be empty/)
  })

  it('grants one speaker, calls only that model and commits under its grant', async () => {
    const manager = scriptedModel(['I lead the standup.'])
    const peer = scriptedModel(['I have a question.'])
    const { driver, harness } = openMulti({
      models: [
        ['manager', manager],
        ['peer', peer],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
    })

    await driver.send('Good morning, team.')
    const events = await runToEnd(driver, harness)

    expect(manager.requests).toHaveLength(1)
    expect(peer.requests).toHaveLength(0)

    const granted = events.find((event) => event.type === 'turn.granted')
    expect(granted?.payload).toMatchObject({ grant: { personaId: 'manager' } })
    const grantId = (granted?.payload as { grant: { grantId: string } }).grant.grantId
    const chunks = events.filter((event) => event.type === 'persona.response.chunk')
    expect(chunks).toMatchObject([{ payload: { grantId, text: 'I lead the standup.' } }])
    expect(types(events)).toEqual([
      'session.started',
      'user.utterance.committed',
      'turn.opened',
      'persona.requested_turn',
      'persona.declined',
      'turn.granted',
      'persona.response.started',
      'persona.response.chunk',
      'persona.utterance.partial',
      'persona.response.committed',
      'turn.revoked',
      'session.completed',
    ])
    expect(guardTurnEvents(events).ok).toBe(true)
  })

  it('yields to the learner when every persona declines', async () => {
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['x'])],
        ['peer', scriptedModel(['y'])],
      ],
      policy: { decide: () => ({ kind: 'decline' }) },
    })

    await driver.send('Anyone?')
    const events = await runToEnd(driver, harness)

    expect(events.filter((event) => event.type === 'turn.granted')).toHaveLength(0)
    expect(events.at(-2)?.type).toBe('turn.user_yielded')
    expect(events.at(-2)?.payload).toEqual({ reason: 'all_declined' })
    expect(guardTurnEvents(events).ok).toBe(true)
  })

  it('records a policy timeout as a failed policy, never as a decline', async () => {
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['x'])],
        ['peer', scriptedModel(['y'])],
      ],
      requestWindowMs: 10,
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return new Promise(() => undefined)
        },
      },
    })

    await driver.send('Manager?')
    const events = await runToEnd(driver, harness)

    expect(events.filter((event) => event.type === 'persona.declined')).toHaveLength(1)
    expect(events.at(-2)?.type).toBe('turn.user_yielded')
    expect(events.at(-2)?.payload).toEqual({ reason: 'policy_timeout' })
  })

  it('sends the greeting to the opening persona without a policy call', async () => {
    const manager = scriptedModel(['Welcome to the standup.'])
    const peer = scriptedModel(['should not run'])
    const calls: PersonaPolicyInput<TestContext>[] = []
    const { driver, harness } = openMulti({
      models: [
        ['manager', manager],
        ['peer', peer],
      ],
      policy: {
        decide(input) {
          calls.push(input)
          return { kind: 'decline' }
        },
      },
    })

    await driver.start()
    const events = await runToEnd(driver, harness)

    expect(calls).toHaveLength(0)
    expect(manager.requests).toHaveLength(1)
    expect(peer.requests).toHaveLength(0)
    expect(types(events)).toEqual([
      'session.started',
      'turn.opened',
      'turn.granted',
      'persona.response.started',
      'persona.response.chunk',
      'persona.response.committed',
      'session.completed',
    ])
    expect(guardTurnEvents(events).ok).toBe(true)
  })

  it('revokes on barge-in and never publishes a chunk from the revoked grant', async () => {
    const manager = scriptedModel(['one ', 'two ', 'three ', 'four '])
    const { driver, harness } = openMulti({
      models: [
        ['manager', manager],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
    })

    let interrupted = false
    harness.onEvent((event) => {
      if (event.type === 'persona.response.chunk' && !interrupted) {
        interrupted = true
        void driver.interrupt()
      }
    })

    await driver.send('Go on.')
    const events = await runToEnd(driver, harness)

    const revokedAt = events.findIndex(
      (event) => event.type === 'turn.revoked' && event.payload.reason === 'user_barge_in',
    )
    const chunkAfter = events
      .slice(revokedAt + 1)
      .filter((event) => event.type === 'persona.response.chunk')
    expect(revokedAt).toBeGreaterThan(-1)
    expect(chunkAfter).toHaveLength(0)
    expect(events.at(-1)?.type).toBe('session.completed')
    expect(guardTurnEvents(events).ok).toBe(true)
  })

  it('revokes and re-grants atomically when another persona interjects', async () => {
    const manager = scriptedModel(['first ', 'second ', 'third '])
    const peer = scriptedModel(['let me stop you'])
    const { driver, harness } = openMulti({
      models: [
        ['manager', manager],
        ['peer', peer],
      ],
      policy: {
        decide(input) {
          if (input.action === 'interject') {
            if (input.personaId !== 'peer') return { kind: 'decline' }
            return {
              kind: 'request',
              request: interjectRequest(input.turnId, input.personaId, input.targetGrantId!),
            }
          }
          // Both ask to speak; the scripted arbiter grants the first request.
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
    })

    await driver.send('Manager, walk us through it.')
    const events = await runToEnd(driver, harness)

    const grants = events
      .filter((event) => event.type === 'turn.granted')
      .map((event) => (event.payload as { grant: { personaId: string } }).grant.personaId)
    expect(grants).toEqual(['manager', 'peer'])
    expect(peer.requests).toHaveLength(1)
    expect(manager.requests).toHaveLength(1)
    expect(guardTurnEvents(events).ok).toBe(true)
  })

  it('preserves the speaker on assistant history for the routing context', async () => {
    const messagesSeen: ConversationMessage[][] = []
    const { driver } = openMulti({
      models: [
        ['manager', scriptedModel(['hello'])],
        ['peer', scriptedModel(['hi'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
      messagesSeen,
    })

    await driver.send('first')
    await driver.send('second')
    await driver.close()

    expect(messagesSeen).toHaveLength(2)
    expect(messagesSeen[1]).toMatchObject([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'hello', personaId: 'manager' },
      { role: 'user', content: 'second' },
    ])
  })

  it('cancels a grant that outlives its deadline with a timeout, not a failure', async () => {
    const clock = new FakeClock(0)
    const manager = scriptedModel(['one ', 'two '], {
      beforeChunk(index) {
        if (index === 1) clock.advance(61_000)
      },
    })
    const { driver, harness } = openMulti(
      {
        models: [
          ['manager', manager],
          ['peer', scriptedModel(['peer'])],
        ],
        policy: {
          decide(input) {
            if (input.personaId === 'peer') return { kind: 'decline' }
            return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
          },
        },
      },
      clock,
    )

    await driver.send('Go on.')
    const events = await runToEnd(driver, harness)

    expect(
      events.some(
        (event) =>
          event.type === 'turn.revoked' &&
          (event.payload as { reason: string }).reason === 'timeout',
      ),
    ).toBe(true)
    expect(
      events.some(
        (event) =>
          event.type === 'persona.response.cancelled' &&
          (event.payload as { reason: string }).reason === 'timeout',
      ),
    ).toBe(true)
    expect(guardTurnEvents(events).ok).toBe(true)
  })

  it('reports a failing provider as a failure, never as an empty commit', async () => {
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['never'], { fail: true })],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
    })

    await driver.send('Go on.')
    const events = await runToEnd(driver, harness)

    expect(events.some((event) => event.type === 'persona.response.committed')).toBe(false)
    expect(
      events.some(
        (event) =>
          event.type === 'persona.response.cancelled' &&
          (event.payload as { reason: string }).reason === 'provider_failure',
      ),
    ).toBe(true)
    expect(
      events.some(
        (event) =>
          event.type === 'turn.revoked' &&
          (event.payload as { reason: string }).reason === 'provider_failure',
      ),
    ).toBe(true)
  })

  it('treats a chunk after the final chunk as a provider failure', async () => {
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['done'], { lateChunk: true })],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
    })

    await driver.send('Go on.')
    const events = await runToEnd(driver, harness)

    expect(
      events.some(
        (event) =>
          event.type === 'persona.response.cancelled' &&
          (event.payload as { detail?: string }).detail ===
            'provider yielded a chunk after the final chunk',
      ),
    ).toBe(true)
  })

  it('bounds the rolling history and keeps it starting with a user turn', async () => {
    const messagesSeen: ConversationMessage[][] = []
    const { driver } = openMulti({
      models: [
        ['manager', scriptedModel(['a1'])],
        ['peer', scriptedModel(['p1'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
      maxHistoryMessages: 2,
      messagesSeen,
    })

    await driver.send('one')
    await driver.send('two')
    await driver.send('three')
    await driver.close()

    expect(messagesSeen[1]).toEqual([{ role: 'user', content: 'two' }])
    expect(messagesSeen[2]).toEqual([{ role: 'user', content: 'three' }])
  })

  it('does not build a routing context for the greeting', async () => {
    const messagesSeen: ConversationMessage[][] = []
    const { driver } = openMulti({
      models: [
        ['manager', scriptedModel(['hello'])],
        ['peer', scriptedModel(['hi'])],
      ],
      policy: { decide: () => ({ kind: 'decline' }) },
      messagesSeen,
    })

    await driver.start()
    await driver.close()

    expect(messagesSeen).toHaveLength(0)
  })

  it('uses the injected seed and the documented defaults', async () => {
    const inputs: SessionArbiterInput<TestContext>[] = []
    const seedSource = vi.fn(() => 42)
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['hello'])],
        ['peer', scriptedModel(['hi'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
      arbiterInputs: inputs,
      seedSource,
    })

    await driver.send('hello')
    const events = await runToEnd(driver, harness)

    expect(seedSource).toHaveBeenCalledTimes(1)
    expect(inputs[0]).toMatchObject({ kind: 'user_committed', seed: 42 })
    expect(events[0]?.payload).toStrictEqual({
      sessionId: 'multi-1',
      clockMode: 'simulated',
      lang: 'en',
    })
    expect(
      events.find((event) => event.type === 'user.utterance.committed')?.payload,
    ).toStrictEqual({ text: 'hello' })
  })

  it('rejects an unusable request window or history bound', () => {
    const base = {
      sessionId: 's',
      lang: 'en' as const,
      clock: new FakeClock(0),
      personas: [{ personaId: 'manager', model: scriptedModel(['x']) }],
      arbiter: scriptedArbiter(),
      policy: { decide: () => ({ kind: 'decline' as const }) },
      buildContext: () => ({ turnId: 't' }),
    }
    expect(() => createTextSessionDriver({ ...base, requestWindowMs: 0 })).toThrow(
      /requestWindowMs/,
    )
    expect(() => createTextSessionDriver({ ...base, requestWindowMs: 1.5 })).toThrow(
      /requestWindowMs/,
    )
    expect(() => createTextSessionDriver({ ...base, maxHistoryMessages: 0 })).toThrow(
      /maxHistoryMessages/,
    )
  })

  it('records a malformed speak decision as a failed policy call', async () => {
    const inputs: SessionArbiterInput<TestContext>[] = []
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['never'])],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return {
            kind: 'request',
            request: speakRequest('another-turn', input.personaId),
          }
        },
      },
      arbiterInputs: inputs,
    })

    await driver.send('hi')
    const events = await runToEnd(driver, harness)

    expect(inputs.some((input) => input.kind === 'policy_failed' && input.cause === 'error')).toBe(
      true,
    )
    expect(events.filter((event) => event.type === 'turn.granted')).toHaveLength(0)
  })

  it('records a policy error as failed, never as a decline', async () => {
    const inputs: SessionArbiterInput<TestContext>[] = []
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['never'])],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          throw new Error('policy exploded')
        },
      },
      arbiterInputs: inputs,
    })

    await driver.send('hi')
    const events = await runToEnd(driver, harness)

    expect(inputs.some((input) => input.kind === 'policy_failed' && input.cause === 'error')).toBe(
      true,
    )
    expect(events.at(-2)?.payload).toEqual({ reason: 'policy_timeout' })
  })

  it('records a malformed interject decision without stopping the stream', async () => {
    const inputs: SessionArbiterInput<TestContext>[] = []
    const manager = scriptedModel(['done'])
    const { driver, harness } = openMulti({
      models: [
        ['manager', manager],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'manager') {
            return { kind: 'request', request: speakRequest(input.turnId, 'manager') }
          }
          if (input.action === 'speak') {
            return { kind: 'request', request: speakRequest(input.turnId, 'peer') }
          }
          return {
            kind: 'request',
            request: interjectRequest(input.turnId, 'peer', 'wrong-grant'),
          }
        },
      },
      arbiterInputs: inputs,
    })

    await driver.send('hi')
    const events = await runToEnd(driver, harness)

    expect(inputs.some((input) => input.kind === 'policy_failed' && input.cause === 'error')).toBe(
      true,
    )
    expect(events.some((event) => event.type === 'persona.response.committed')).toBe(true)
  })

  it('does not ask a declined persona to interject', async () => {
    const calls: string[] = []
    const { driver } = openMulti({
      models: [
        ['manager', scriptedModel(['done'])],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          calls.push(`${input.personaId}:${input.action}`)
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, 'manager') }
        },
      },
    })

    await driver.send('hi')
    await driver.close()

    expect(calls.filter((call) => call.startsWith('peer:'))).toEqual(['peer:speak'])
  })

  it('bounds an interject decision with the request window and keeps streaming', async () => {
    const inputs: SessionArbiterInput<TestContext>[] = []
    let interjectCalls = 0
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['done'])],
        ['peer', scriptedModel(['peer'])],
      ],
      requestWindowMs: 10,
      policy: {
        decide(input) {
          if (input.action === 'interject') {
            interjectCalls += 1
            return new Promise(() => undefined)
          }
          if (input.personaId === 'peer') {
            return { kind: 'request', request: speakRequest(input.turnId, 'peer') }
          }
          return { kind: 'request', request: speakRequest(input.turnId, 'manager') }
        },
      },
      arbiterInputs: inputs,
    })

    await driver.send('hi')
    const events = await runToEnd(driver, harness)

    expect(interjectCalls).toBeGreaterThan(0)
    expect(inputs.some((input) => input.kind === 'policy_failed')).toBe(true)
    expect(events.some((event) => event.type === 'persona.response.committed')).toBe(true)
  })

  it('closes cleanly when close arrives mid-stream', async () => {
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['one', 'two', 'three'])],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, 'manager') }
        },
      },
    })

    let closing = false
    harness.onEvent((event) => {
      if (event.type === 'persona.response.chunk' && !closing) {
        closing = true
        void driver.close()
      }
    })

    await driver.send('go')
    await harness.finished()

    expect(harness.events.at(-1)?.type).toBe('session.completed')
    const completedAt = harness.events.findIndex((event) => event.type === 'session.completed')
    expect(
      harness.events
        .slice(completedAt + 1)
        .filter((event) => event.type === 'persona.response.chunk'),
    ).toHaveLength(0)
  })

  it('cancels before the first chunk without inventing partial text', async () => {
    const harnessMessagesSeen: ConversationMessage[][] = []
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['one'])],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, 'manager') }
        },
      },
      messagesSeen: harnessMessagesSeen,
    })

    let interrupted = false
    harness.onEvent((event) => {
      if (event.type === 'persona.response.started' && !interrupted) {
        interrupted = true
        void driver.interrupt()
      }
    })

    await driver.send('go')
    await driver.send('next')
    const events = await runToEnd(driver, harness)

    const cancelled = events.find((event) => event.type === 'persona.response.cancelled')
    expect(cancelled?.payload).toStrictEqual({
      grantId: expect.any(String),
      reason: 'user_barge_in',
    })
    expect(harnessMessagesSeen.at(-1)?.some((message) => message.content === '')).toBe(false)
  })

  it('barges in during the request window without granting a speaker', async () => {
    const inputs: SessionArbiterInput<TestContext>[] = []
    let policyStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      policyStarted = resolve
    })
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['one'])],
        ['peer', scriptedModel(['peer'])],
      ],
      requestWindowMs: 10,
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          policyStarted()
          return new Promise(() => undefined)
        },
      },
      arbiterInputs: inputs,
    })

    const pending = driver.send('go')
    await started
    await driver.interrupt()
    await pending
    const events = await runToEnd(driver, harness)

    expect(events.some((event) => event.type === 'user.barge_in')).toBe(true)
    expect(events.filter((event) => event.type === 'turn.granted')).toHaveLength(0)
    expect(inputs.filter((input) => input.kind === 'user_barge_in')).toHaveLength(1)
  })

  it('closes an unfinished window at the later of the clock and the deadline', async () => {
    const clock = new FakeClock(0)
    const inputs: SessionArbiterInput<TestContext>[] = []
    const { driver } = openMulti(
      {
        models: [
          ['manager', scriptedModel(['never'])],
          ['peer', scriptedModel(['peer'])],
        ],
        policy: {
          decide(input) {
            if (input.personaId === 'peer') return { kind: 'decline' }
            clock.advance(5_000)
            return { kind: 'decline' }
          },
        },
        arbiterInputs: inputs,
      },
      clock,
    )

    await driver.send('go')
    await driver.close()

    expect(inputs).toContainEqual({ kind: 'tick', nowMs: 5_000 })
  })

  it('falls back to the opening turn when a grant has no metadata', async () => {
    const manager = scriptedModel(['done'], { delayMs: 20 })
    const arbiter: SessionArbiterPort<TestState, TestContext> = {
      initialState: { phase: 'idle' },
      reduce(state, input) {
        if (input.kind === 'user_committed') {
          return {
            state,
            effects: [{ kind: 'start_generation', grantId: 'g1', personaId: 'manager' }],
          }
        }
        return { state, effects: [] }
      },
    }
    const { driver, harness } = openMulti({
      models: [
        ['manager', manager],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, 'manager') }
        },
      },
      arbiter,
    })

    await driver.send('go')
    const events = await runToEnd(driver, harness)

    expect(manager.requests[0]?.requestId).toBe('multi-1-turn-1')
    expect(events.some((event) => event.type === 'persona.response.committed')).toBe(true)
  })

  it('carries usage on the committed response', async () => {
    const usage = { inputTokens: 5, outputTokens: 6, costUsd: 0.02 }
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['done'], { usage })],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, 'manager') }
        },
      },
    })

    await driver.send('go')
    const events = await runToEnd(driver, harness)

    const committed = events.find((event) => event.type === 'persona.response.committed')
    expect(committed?.payload).toStrictEqual({
      grantId: (committed?.payload as { grantId: string }).grantId,
      text: 'done',
      usage,
    })
  })

  it('requires each multi-persona dependency separately', () => {
    const base = {
      sessionId: 's',
      lang: 'en' as const,
      clock: new FakeClock(0),
      personas: [{ personaId: 'manager', model: scriptedModel(['x']) }],
    }
    const policy = { decide: () => ({ kind: 'decline' as const }) }
    const arbiter = scriptedArbiter()
    const buildContext = () => ({ turnId: 't' })

    expect(() => createTextSessionDriver({ ...base })).toThrow(/require an arbiter and a policy/)
    expect(() => createTextSessionDriver({ ...base, policy, buildContext })).toThrow(
      /require an arbiter and a policy/,
    )
    expect(() => createTextSessionDriver({ ...base, arbiter, buildContext })).toThrow(
      /require an arbiter and a policy/,
    )
    expect(() =>
      createTextSessionDriver({ ...base, personas: [], arbiter, policy, buildContext }),
    ).toThrow(/personas must not be empty/)
    expect(() =>
      createTextSessionDriver({ ...base, arbiter, policy, buildContext, requestWindowMs: 1 }),
    ).not.toThrow()
  })

  it('injects a numeric seed when no source is given', async () => {
    const inputs: SessionArbiterInput<TestContext>[] = []
    const driver = createTextSessionDriver({
      sessionId: 'multi-1',
      lang: 'en',
      clock: new FakeClock(0),
      personas: [
        { personaId: 'manager', model: scriptedModel(['hello']) },
        { personaId: 'peer', model: scriptedModel(['hi']) },
      ],
      arbiter: scriptedArbiter(inputs),
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, 'manager') }
        },
      },
      buildContext: () => ({ turnId: 't' }),
    })

    await driver.send('hello')
    await driver.close()

    const committed = inputs.find((input) => input.kind === 'user_committed')
    expect(typeof (committed as { seed: number }).seed).toBe('number')
    const events: SessionEvent[] = []
    for await (const event of driver.events) events.push(event)
    expect(events[0]?.payload).toStrictEqual({
      sessionId: 'multi-1',
      clockMode: 'simulated',
      lang: 'en',
    })
  })

  it('opens the greeting with the opening turn, pack and no arbiter tracking', async () => {
    const manager = scriptedModel(['welcome'])
    const greeting = [{ role: 'system' as const, content: 'greeting pack' }]
    const arbiterInputs: SessionArbiterInput<TestContext>[] = []
    const driver = createTextSessionDriver({
      sessionId: 'multi-1',
      lang: 'en',
      clock: new FakeClock(0),
      personas: [{ personaId: 'manager', model: manager, greetingInstructions: greeting }],
      arbiter: scriptedArbiter(arbiterInputs),
      policy: { decide: () => ({ kind: 'decline' }) },
      buildContext: () => ({ turnId: 't' }),
    })

    await driver.start()
    await driver.close()
    const events: SessionEvent[] = []
    for await (const event of driver.events) events.push(event)

    expect(events[1]).toStrictEqual({ type: 'turn.opened', payload: { turnId: 'multi-1-turn-1' } })
    expect(events[2]?.payload).toMatchObject({
      grant: {
        turnId: 'multi-1-turn-1',
        grantId: 'multi-1-grant-greeting-1',
        personaId: 'manager',
      },
    })
    expect(manager.requests[0]?.messages).toEqual(greeting)
    expect(events.some((event) => event.type === 'persona.response.committed')).toBe(true)
    expect(arbiterInputs.filter((input) => input.kind !== 'close')).toEqual([])
  })

  it('stamps a registered task id on session.started', async () => {
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['hello'])],
        ['peer', scriptedModel(['hi'])],
      ],
      policy: { decide: () => ({ kind: 'decline' }) },
      taskId: 'task-1',
      clockMode: 'wall',
    })

    await driver.close()
    await harness.finished()

    expect(harness.events[0]?.payload).toStrictEqual({
      sessionId: 'multi-1',
      clockMode: 'wall',
      lang: 'en',
      taskId: 'task-1',
    })
  })

  it('fails the event queue when the configured bound is exceeded', async () => {
    const driver = createTextSessionDriver({
      sessionId: 'multi-1',
      lang: 'en',
      clock: new FakeClock(0),
      personas: [
        { personaId: 'manager', model: scriptedModel(['hello']) },
        { personaId: 'peer', model: scriptedModel(['hi']) },
      ],
      arbiter: scriptedArbiter(),
      policy: { decide: () => ({ kind: 'decline' }) },
      buildContext: () => ({ turnId: 't' }),
      maxQueuedEvents: 1,
    })

    await driver.send('go')

    await expect(
      (async () => {
        for await (const _event of driver.events) {
          // Drain nothing: the bound is already exceeded.
        }
      })(),
    ).rejects.toThrow(/not keeping up/)
  })

  it('ignores a cancel for a stale grant while the current one streams', async () => {
    let emitted = 0
    const arbiter: SessionArbiterPort<TestState, TestContext> = {
      initialState: { phase: 'idle' },
      reduce(state, input) {
        if (input.kind === 'user_committed') {
          return {
            state,
            effects: [
              {
                kind: 'emit_event',
                type: 'turn.granted',
                payload: {
                  grant: {
                    turnId: input.turnId,
                    grantId: 'current',
                    personaId: 'manager',
                    expiresAt: new Date(input.nowMs + 60_000).toISOString(),
                  },
                },
              },
              { kind: 'start_generation', grantId: 'current', personaId: 'manager' },
            ],
          }
        }
        if (input.kind === 'partial' && emitted === 0) {
          emitted = 1
          return {
            state,
            effects: [{ kind: 'cancel_generation', grantId: 'stale', reason: 'interrupted' }],
          }
        }
        return { state, effects: [] }
      },
    }
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['one', 'two'])],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: { decide: () => ({ kind: 'decline' }) },
      arbiter,
    })

    await driver.send('go')
    const events = await runToEnd(driver, harness)

    expect(events.filter((event) => event.type === 'persona.response.chunk')).toHaveLength(2)
    expect(events.some((event) => event.type === 'persona.response.committed')).toBe(true)
  })

  it('ends the session when the arbiter asks to close it', async () => {
    const arbiter: SessionArbiterPort<TestState, TestContext> = {
      initialState: { phase: 'idle' },
      reduce(state, input) {
        if (input.kind === 'user_committed') {
          return { state, effects: [{ kind: 'close_session' }] }
        }
        return { state, effects: [] }
      },
    }
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['hello'])],
        ['peer', scriptedModel(['hi'])],
      ],
      policy: { decide: () => ({ kind: 'decline' }) },
      arbiter,
    })

    await driver.send('go')
    await harness.finished()

    expect(harness.events.some((event) => event.type === 'session.completed')).toBe(false)
    await expect(driver.send('again')).rejects.toThrow(/session is closed/)
  })

  it('rejects a grant that names a persona the session does not have', async () => {
    const arbiter: SessionArbiterPort<TestState, TestContext> = {
      initialState: { phase: 'idle' },
      reduce(state) {
        return {
          state,
          effects: [{ kind: 'start_generation', grantId: 'g1', personaId: 'ghost' }],
        }
      },
    }
    const { driver } = openMulti({
      models: [
        ['manager', scriptedModel(['hello'])],
        ['peer', scriptedModel(['hi'])],
      ],
      policy: { decide: () => ({ kind: 'decline' }) },
      arbiter,
    })

    await expect(driver.send('go')).rejects.toThrow(/unknown persona/)
  })

  it('closes an all-declined window at the request window deadline', async () => {
    const inputs: SessionArbiterInput<TestContext>[] = []
    const { driver } = openMulti({
      models: [
        ['manager', scriptedModel(['hello'])],
        ['peer', scriptedModel(['hi'])],
      ],
      policy: { decide: () => ({ kind: 'decline' }) },
      arbiterInputs: inputs,
    })

    await driver.send('go')
    await driver.close()

    expect(inputs).toContainEqual({ kind: 'tick', nowMs: 1_500 })
  })

  it('resets per-turn failure state before the next turn', async () => {
    const calls: string[] = []
    let turn = 0
    const { driver } = openMulti({
      models: [
        ['manager', scriptedModel(['never'])],
        ['peer', scriptedModel(['answer', 'answer'])],
      ],
      policy: {
        async decide(input) {
          calls.push(`${input.personaId}:${input.action}`)
          if (input.action === 'interject') return { kind: 'decline' }
          if (input.personaId === 'manager') {
            const first = turn === 0
            turn = 1
            if (first) throw new Error('manager failed')
            // Let the peer's synchronous request win the window after the retry.
            await Promise.resolve()
          }
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
    })

    await driver.send('first')
    await driver.send('second')
    await driver.close()

    expect(calls.filter((call) => call === 'manager:speak')).toHaveLength(2)
    expect(calls).toContain('manager:interject')
  })

  it('does not retry an interject policy that already failed for this grant', async () => {
    let interjectCalls = 0
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['one', 'two'])],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          if (input.action === 'interject') {
            interjectCalls += 1
            throw new Error('interject failed')
          }
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
    })

    await driver.send('go')
    await runToEnd(driver, harness)

    expect(interjectCalls).toBe(1)
  })

  it('keeps the holder when the other persona declines to interject', async () => {
    const inputs: SessionArbiterInput<TestContext>[] = []
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['answer'])],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          if (input.action === 'interject') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
      arbiterInputs: inputs,
    })

    await driver.send('go')
    const events = await runToEnd(driver, harness)

    expect(inputs.some((input) => input.kind === 'policy_failed')).toBe(false)
    expect(events.some((event) => event.type === 'persona.response.committed')).toBe(true)
    expect(
      events.filter(
        (event) =>
          event.type === 'turn.granted' &&
          (event.payload as { grant: { personaId: string } }).grant.personaId === 'manager',
      ),
    ).toHaveLength(1)
  })

  it('records an interject policy error without losing the holder', async () => {
    const inputs: SessionArbiterInput<TestContext>[] = []
    const seen: PersonaPolicyInput<TestContext>[] = []
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['answer'])],
        ['peer', scriptedModel(['peer'])],
      ],
      locale: 'en-GB',
      policy: {
        decide(input) {
          if (input.action === 'interject') {
            seen.push(input)
            throw new Error('interject failed')
          }
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
      arbiterInputs: inputs,
    })

    await driver.send('go')
    const events = await runToEnd(driver, harness)

    expect(inputs.some((input) => input.kind === 'policy_failed' && input.cause === 'error')).toBe(
      true,
    )
    expect(events.some((event) => event.type === 'persona.response.committed')).toBe(true)
    expect(seen[0]?.targetGrantId).toMatch(/^test:/)
    expect(seen[0]?.locale).toBe('en-GB')
  })

  it('passes target grant, history and locale to an interject decision', async () => {
    const decisions: PersonaPolicyInput<TestContext>[] = []
    const { driver } = openMulti({
      models: [
        ['manager', scriptedModel(['answer'])],
        ['peer', scriptedModel(['peer'])],
      ],
      locale: 'en-GB',
      policy: {
        decide(input) {
          if (input.action === 'interject') {
            decisions.push(input)
            return { kind: 'decline' }
          }
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
    })

    await driver.send('the question')
    await driver.close()

    expect(decisions[0]?.action).toBe('interject')
    expect(decisions[0]?.targetGrantId).toMatch(/^test:/)
    expect(decisions[0]?.locale).toBe('en-GB')
    expect(decisions[0]?.messages).toContainEqual({ role: 'user', content: 'the question' })
  })

  it('preserves cancelled partial text as history for the next turn', async () => {
    const messagesSeen: ConversationMessage[][] = []
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['partial ', 'answer'])],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, 'manager') }
        },
      },
      messagesSeen,
    })

    let interrupted = false
    harness.onEvent((event) => {
      if (event.type === 'persona.response.chunk' && !interrupted) {
        interrupted = true
        void driver.interrupt()
      }
    })

    await driver.send('first')
    await driver.send('second')
    await driver.close()

    expect(messagesSeen[1]).toContainEqual({
      role: 'assistant',
      content: 'partial ',
      personaId: 'manager',
    })
    const cancelled = harness.events.find((event) => event.type === 'persona.response.cancelled')
    expect(cancelled?.payload).toStrictEqual({
      grantId: expect.any(String),
      reason: 'user_barge_in',
      partialText: 'partial ',
    })
  })

  it('never trims the greeting from the routing context', async () => {
    const messagesSeen: ConversationMessage[][] = []
    const driver = createTextSessionDriver({
      sessionId: 'multi-1',
      lang: 'en',
      clock: new FakeClock(0),
      personas: [
        { personaId: 'manager', model: scriptedModel(['welcome']) },
        { personaId: 'peer', model: scriptedModel(['peer']) },
      ],
      arbiter: scriptedArbiter(),
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, 'manager') }
        },
      },
      buildContext: (input) => {
        messagesSeen.push([...input.messages])
        return { turnId: input.turnId }
      },
      maxHistoryMessages: 2,
    })

    await driver.start()
    await driver.send('one')
    await driver.send('two')
    await driver.close()

    expect(messagesSeen.at(-1)?.[0]).toMatchObject({ role: 'assistant', content: 'welcome' })
  })

  it('closes an untouched session and refuses start afterwards', async () => {
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['hello'])],
        ['peer', scriptedModel(['hi'])],
      ],
      policy: { decide: () => ({ kind: 'decline' }) },
    })

    await driver.close()
    await harness.finished()

    expect(harness.events.filter((event) => event.type === 'session.completed')).toHaveLength(1)
    await expect(driver.start()).rejects.toThrow(/session is closed/)
  })

  it('uses the fallback deadline when a grant carries an unusable one', async () => {
    const manager = scriptedModel(['done'], { delayMs: 20 })
    const arbiter: SessionArbiterPort<TestState, TestContext> = {
      initialState: { phase: 'idle' },
      reduce(state, input) {
        if (input.kind === 'user_committed') {
          return {
            state,
            effects: [
              {
                kind: 'emit_event',
                type: 'turn.granted',
                payload: {
                  grant: {
                    turnId: input.turnId,
                    grantId: 'g1',
                    personaId: 'manager',
                    expiresAt: 'not-a-date',
                  },
                },
              },
              { kind: 'start_generation', grantId: 'g1', personaId: 'manager' },
            ],
          }
        }
        return { state, effects: [] }
      },
    }
    const { driver, harness } = openMulti({
      models: [
        ['manager', manager],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: { decide: () => ({ kind: 'decline' }) },
      arbiter,
    })

    await driver.send('go')
    const events = await runToEnd(driver, harness)

    expect(events.some((event) => event.type === 'persona.response.committed')).toBe(true)
  })

  it('ignores a cancel effect while no generation is active', async () => {
    let turns = 0
    const arbiter: SessionArbiterPort<TestState, TestContext> = {
      initialState: { phase: 'idle' },
      reduce(state, input) {
        if (input.kind === 'user_committed') {
          turns += 1
          return {
            state,
            effects:
              turns > 1
                ? [{ kind: 'cancel_generation', grantId: 'stale', reason: 'interrupted' }]
                : [emit('turn.opened', { turnId: input.turnId })],
          }
        }
        return { state, effects: [] }
      },
    }
    const { driver } = openMulti({
      models: [
        ['manager', scriptedModel(['hello'])],
        ['peer', scriptedModel(['hi'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, 'manager') }
        },
      },
      arbiter,
    })

    await driver.send('first')
    await expect(driver.send('second')).resolves.toBeUndefined()
    await driver.close()
  })

  it('records a completed response_ended for the arbiter', async () => {
    const inputs: SessionArbiterInput<TestContext>[] = []
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['hello'])],
        ['peer', scriptedModel(['hi'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, 'manager') }
        },
      },
      arbiterInputs: inputs,
    })

    await driver.send('go')
    await runToEnd(driver, harness)

    expect(inputs.find((input) => input.kind === 'response_ended')).toMatchObject({
      outcome: 'completed',
    })
  })

  it('rejects a multi-persona driver constructed without personas', () => {
    expect(
      () =>
        new MultiPersonaSessionDriver({
          sessionId: 's',
          lang: 'en',
          clock: new FakeClock(0),
          arbiter: scriptedArbiter(),
          policy: { decide: () => ({ kind: 'decline' }) },
          buildContext: () => ({ turnId: 't' }),
        }),
    ).toThrow(/personas must not be empty/)
  })

  it('does not ask a failed speak policy to interject', async () => {
    const calls: string[] = []
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['never'])],
        ['peer', scriptedModel(['answer'])],
      ],
      policy: {
        decide(input) {
          calls.push(`${input.personaId}:${input.action}`)
          if (input.personaId === 'manager') throw new Error('manager failed')
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
    })

    await driver.send('go')
    await runToEnd(driver, harness)

    expect(calls.filter((call) => call === 'manager:interject')).toHaveLength(0)
  })

  it('does not ask a malformed speak policy to interject', async () => {
    const calls: string[] = []
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['never'])],
        ['peer', scriptedModel(['answer'])],
      ],
      policy: {
        decide(input) {
          calls.push(`${input.personaId}:${input.action}`)
          if (input.personaId === 'manager') {
            return { kind: 'request', request: speakRequest('other-turn', input.personaId) }
          }
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
    })

    await driver.send('go')
    await runToEnd(driver, harness)

    expect(calls.filter((call) => call === 'manager:interject')).toHaveLength(0)
  })

  it('does not retry a malformed interject decision for the same grant', async () => {
    let interjectCalls = 0
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['one', 'two'])],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          if (input.action === 'interject') {
            interjectCalls += 1
            return { kind: 'request', request: interjectRequest(input.turnId, 'peer', 'wrong') }
          }
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
    })

    await driver.send('go')
    await runToEnd(driver, harness)

    expect(interjectCalls).toBe(1)
  })

  it('names the interjection as a revoked cancellation', async () => {
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['one', 'two'])],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          if (input.action === 'interject') {
            return {
              kind: 'request',
              request: interjectRequest(input.turnId, 'peer', input.targetGrantId!),
            }
          }
          return { kind: 'request', request: speakRequest(input.turnId, input.personaId) }
        },
      },
    })

    await driver.send('go')
    const events = await runToEnd(driver, harness)

    const cancelled = events.filter((event) => event.type === 'persona.response.cancelled')
    expect(cancelled[0]?.payload).toMatchObject({ reason: 'revoked' })
  })

  it('closes a stream with an interrupted cancellation and no partial text', async () => {
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['one'])],
        ['peer', scriptedModel(['peer'])],
      ],
      policy: {
        decide(input) {
          if (input.personaId === 'peer') return { kind: 'decline' }
          return { kind: 'request', request: speakRequest(input.turnId, 'manager') }
        },
      },
    })

    let closing = false
    harness.onEvent((event) => {
      if (event.type === 'persona.response.started' && !closing) {
        closing = true
        void driver.close()
      }
    })

    await driver.send('go')
    await harness.finished()

    const cancelled = harness.events.find((event) => event.type === 'persona.response.cancelled')
    expect(cancelled?.payload).toMatchObject({ reason: 'interrupted' })
  })

  it('rejects a second start and a send after close', async () => {
    const { driver } = openMulti({
      models: [
        ['manager', scriptedModel(['hello'])],
        ['peer', scriptedModel(['hi'])],
      ],
      policy: { decide: () => ({ kind: 'decline' }) },
    })

    await driver.start()
    await expect(driver.start()).rejects.toThrow(/only opens an empty session/)
    await expect(driver.send('   ')).rejects.toThrow(/must not be empty/)
    await driver.close()
    await expect(driver.send('again')).rejects.toThrow(/session is closed/)
  })

  it('closes once even when close is called concurrently', async () => {
    const { driver, harness } = openMulti({
      models: [
        ['manager', scriptedModel(['hello'])],
        ['peer', scriptedModel(['hi'])],
      ],
      policy: { decide: () => ({ kind: 'decline' }) },
    })

    await Promise.all([driver.close(), driver.close()])
    await harness.finished()

    expect(harness.events.filter((event) => event.type === 'session.completed')).toHaveLength(1)
  })
})
