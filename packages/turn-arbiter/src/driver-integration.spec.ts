import {
  createTextSessionDriver,
  guardTurnEvents,
  type ConversationMessage,
  type PersonaTurnPolicy,
  type SessionEvent,
  type TextModelChunk,
  type TextModelPort,
  type TurnRequest,
} from '@rp/session-core'
import { FakeClock } from '@rp/shared'
import {
  deterministicJudgments,
  derivePersonaDecision,
  deriveTurnRequest,
  lastUserUtterance,
  type RoutingContext,
  type RoutingPersona,
} from '@rp/routing-policy'
import { describe, expect, it } from 'vitest'
import { INITIAL_ARBITER_STATE, parseTurnArbiterConfig, reduce } from './index.js'

/**
 * The real reducer behind the real driver.
 *
 * This is the contract test for the structural `SessionArbiterPort`: the
 * composition root binds `reduce` with its frozen config, and the driver applies
 * only the effects the reducer emits. Ranking, all-decline, replacement and
 * interjection therefore run end to end without any live provider.
 */

const config = parseTurnArbiterConfig()

const personas: RoutingPersona[] = [
  {
    id: 'manager',
    displayName: 'Sam',
    aliases: [],
    role: 'engineering manager',
    objectives: [{ id: 'm-deadline', description: 'Protect the deadline', keywords: ['deadline'] }],
  },
  {
    id: 'peer',
    displayName: 'Alex',
    aliases: [],
    role: 'peer engineer',
    objectives: [{ id: 'p-scope', description: 'Clarify the scope', keywords: ['scope'] }],
  },
]

function buildContext(turnId: string, messages: readonly ConversationMessage[]): RoutingContext {
  return {
    decisionId: `decision-${turnId}`,
    turnId,
    lang: 'en',
    transcript: messages.map((message) =>
      message.role === 'user'
        ? { speaker: { kind: 'user' }, text: message.content }
        : {
            speaker: { kind: 'persona', personaId: message.personaId ?? 'manager' },
            text: message.content,
          },
    ),
    personas,
    coveredObjectiveIds: [],
  }
}

function deterministicPolicy(): PersonaTurnPolicy<RoutingContext> {
  return {
    decide(input) {
      const persona = input.context.personas.find((entry) => entry.id === input.personaId)
      if (persona === undefined) throw new Error('unknown persona')
      const judgments = deterministicJudgments(
        input.context,
        persona,
        lastUserUtterance(input.context),
      )
      if (derivePersonaDecision(judgments).kind !== 'request') return { kind: 'decline' }
      const request = deriveTurnRequest(input.context, persona, judgments)
      if (input.action === 'interject') {
        return {
          kind: 'request',
          request: { ...request, action: 'interject', targetGrantId: input.targetGrantId },
        }
      }
      return { kind: 'request', request }
    },
  }
}

interface ScriptedModel extends TextModelPort {
  requests: number
}

function scriptedModel(
  chunks: readonly string[],
  options: { readonly beforeChunk?: (index: number) => void; readonly fail?: boolean } = {},
): ScriptedModel {
  const model: ScriptedModel = {
    kind: 'canned',
    label: 'scripted',
    requests: 0,
    async *complete(): AsyncIterable<TextModelChunk> {
      model.requests += 1
      if (options.fail === true) throw new Error('provider failed')
      for (const [index, text] of chunks.entries()) {
        options.beforeChunk?.(index)
        await Promise.resolve()
        yield { text, done: index === chunks.length - 1 }
      }
    },
  }
  return model
}

interface Harness {
  readonly events: SessionEvent[]
  onEvent(listener: (event: SessionEvent) => void): void
  finished(): Promise<void>
}

function open(
  models: readonly [string, TextModelPort][],
  policy: PersonaTurnPolicy<RoutingContext>,
  clock = new FakeClock(0),
): { driver: ReturnType<typeof createTextSessionDriver>; harness: Harness } {
  const driver = createTextSessionDriver({
    sessionId: 'integration-1',
    lang: 'en',
    clockMode: 'simulated',
    clock,
    personas: models.map(([personaId, model]) => ({ personaId, model })),
    arbiter: {
      initialState: INITIAL_ARBITER_STATE,
      reduce: (state, input) => reduce(state, input, config),
    },
    policy,
    buildContext: (input) => buildContext(input.turnId, input.messages),
    seedSource: () => 11,
    requestWindowMs: config.requestWindowMs,
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

async function finish(
  driver: ReturnType<typeof createTextSessionDriver>,
  harness: Harness,
): Promise<SessionEvent[]> {
  await driver.close()
  await harness.finished()
  return harness.events
}

function grantedPersonas(events: readonly SessionEvent[]): string[] {
  return events
    .filter((event) => event.type === 'turn.granted')
    .map((event) => (event.payload as { grant: { personaId: string } }).grant.personaId)
}

describe('turn arbiter behind the multi-persona driver', () => {
  it('ranks a directly addressed persona and keeps the other silent', async () => {
    const manager = scriptedModel(['manager'])
    const peer = scriptedModel(['I can take the scope question.'])
    const { driver, harness } = open(
      [
        ['manager', manager],
        ['peer', peer],
      ],
      deterministicPolicy(),
    )

    await driver.send('Alex, can you clarify the scope for us?')
    const events = await finish(driver, harness)

    expect(grantedPersonas(events)).toEqual(['peer'])
    expect(peer.requests).toBe(1)
    expect(manager.requests).toBe(0)
    expect(events.some((event) => event.type === 'persona.declined')).toBe(true)
    expect(guardTurnEvents(events).ok).toBe(true)
  })

  it('yields to the learner when the real window finds no request', async () => {
    const { driver, harness } = open(
      [
        ['manager', scriptedModel(['manager'])],
        ['peer', scriptedModel(['peer'])],
      ],
      deterministicPolicy(),
    )

    await driver.send('Thanks, that is all for now.')
    const events = await finish(driver, harness)

    expect(grantedPersonas(events)).toEqual([])
    expect(events.at(-2)?.type).toBe('turn.user_yielded')
    expect(events.at(-2)?.payload).toEqual({ reason: 'all_declined' })
    expect(guardTurnEvents(events).ok).toBe(true)
  })

  it('replaces a failed holder with the best remaining requester', async () => {
    const manager = scriptedModel(['never'], { fail: true })
    const peer = scriptedModel(['I can take it.'])
    const policy: PersonaTurnPolicy<RoutingContext> = {
      decide(input) {
        // Both ask, so the failed holder has a legal replacement.
        const request: TurnRequest = {
          turnId: input.turnId,
          personaId: input.personaId,
          action: 'speak',
          urgency: 0,
          confidence: 1,
          addressedByUser: input.personaId === 'manager',
          objectiveRelevance: 0,
        }
        return { kind: 'request', request }
      },
    }
    const { driver, harness } = open(
      [
        ['manager', manager],
        ['peer', peer],
      ],
      policy,
    )

    await driver.send('Sam, go ahead.')
    const events = await finish(driver, harness)

    expect(grantedPersonas(events)).toEqual(['manager', 'peer'])
    expect(manager.requests).toBe(1)
    expect(peer.requests).toBe(1)
    expect(
      events.some(
        (event) =>
          event.type === 'persona.response.cancelled' &&
          (event.payload as { reason: string }).reason === 'provider_failure',
      ),
    ).toBe(true)
    expect(guardTurnEvents(events).ok).toBe(true)
  })

  it('resolves an interjection after the hold and atomically re-grants', async () => {
    const clock = new FakeClock(0)
    const manager = scriptedModel(['hold on, ', 'this is context, ', 'and more.'], {
      beforeChunk(index) {
        if (index === 1) clock.advance(900)
        if (index === 2) clock.advance(900)
      },
    })
    const peer = scriptedModel(['one clarification.'])
    const policy: PersonaTurnPolicy<RoutingContext> = {
      decide(input) {
        if (input.action === 'interject') {
          if (input.personaId !== 'peer') return { kind: 'decline' }
          return {
            kind: 'request',
            request: {
              turnId: input.turnId,
              personaId: 'peer',
              action: 'interject',
              urgency: 0.9,
              confidence: 0.9,
              addressedByUser: false,
              objectiveRelevance: 0.8,
              targetGrantId: input.targetGrantId,
            },
          }
        }
        if (input.personaId === 'manager') {
          return {
            kind: 'request',
            request: {
              turnId: input.turnId,
              personaId: 'manager',
              action: 'speak',
              urgency: 0.5,
              confidence: 0.8,
              addressedByUser: true,
              objectiveRelevance: 0.5,
            },
          }
        }
        // The peer asks to speak too, so it stays eligible to interject later.
        return {
          kind: 'request',
          request: {
            turnId: input.turnId,
            personaId: 'peer',
            action: 'speak',
            urgency: 0.1,
            confidence: 0.4,
            addressedByUser: false,
            objectiveRelevance: 0.1,
          },
        }
      },
    }
    const { driver, harness } = open(
      [
        ['manager', manager],
        ['peer', peer],
      ],
      policy,
      clock,
    )

    await driver.send('Sam, walk us through it.')
    const events = await finish(driver, harness)

    expect(grantedPersonas(events)).toEqual(['manager', 'peer'])
    expect(
      events.some(
        (event) =>
          event.type === 'turn.revoked' &&
          (event.payload as { reason: string }).reason === 'interrupted',
      ),
    ).toBe(true)
    expect(
      events.some(
        (event) =>
          event.type === 'persona.response.cancelled' &&
          (event.payload as { reason: string }).reason === 'revoked',
      ),
    ).toBe(true)
    expect(guardTurnEvents(events).ok).toBe(true)
  })
})
