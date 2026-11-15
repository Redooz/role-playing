import type { RoutingContext } from '@rp/routing-policy'
import { FakeClock } from '@rp/shared'
import type { SessionEvent, TextModelChunk, TextModelPort } from '@rp/session-core'
import { describe, expect, it, vi } from 'vitest'
import { buildSessionCannedEntries, runSessionTask } from './session-runner.js'
import { resolveSessionPrompts, SessionTaskError } from './session-prompt.js'
import { createMultiPersonaDriver, withPlainText } from './session-driver.js'
import {
  DATE,
  multiPersonaTask,
  personaAwareProvider,
  run,
  sessionTask,
  shadowJudge,
  textProvider,
} from './session.fixtures.js'

function modelOf(chunks: readonly TextModelChunk[]): TextModelPort {
  return {
    kind: 'live',
    label: 'fake-model',
    async *complete() {
      for (const chunk of chunks) yield chunk
    },
  }
}

async function drainChunks(model: TextModelPort): Promise<TextModelChunk[]> {
  const chunks: TextModelChunk[] = []
  for await (const chunk of model.complete({ messages: [{ role: 'user', content: 'go' }] })) {
    chunks.push(chunk)
  }
  return chunks
}

async function collectEvents(driver: {
  readonly events: AsyncIterable<SessionEvent>
}): Promise<SessionEvent[]> {
  const events: SessionEvent[] = []
  for await (const event of driver.events) events.push(event)
  return events
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
    ).rejects.toThrow(/requires two/u)
  })
})

describe('withPlainText', () => {
  it('filters Markdown and emoji before the driver sees the stream', async () => {
    const model = withPlainText(
      modelOf([
        { text: '**Hello** there 😀. ', done: false },
        { text: 'Next.', done: true },
      ]),
    )

    const chunks = await drainChunks(model)

    expect(chunks).toStrictEqual([
      { text: 'Hello there.', done: false },
      { text: ' Next.', done: false },
      { text: '', done: true },
    ])
  })

  it('holds back a chunk with no spoken boundary until the flush', async () => {
    const model = withPlainText(
      modelOf([
        { text: 'Hello', done: false },
        { text: '', done: true },
      ]),
    )

    expect(await drainChunks(model)).toStrictEqual([
      { text: 'Hello', done: false },
      { text: '', done: true },
    ])
  })

  it('does not emit an empty tail when the buffer was already spoken', async () => {
    const model = withPlainText(
      modelOf([
        { text: 'Hello. ', done: false },
        { text: '', done: true },
      ]),
    )

    expect(await drainChunks(model)).toStrictEqual([
      { text: 'Hello.', done: false },
      { text: '', done: true },
    ])
  })

  it('forwards token usage on the final chunk', async () => {
    const model = withPlainText(
      modelOf([{ text: 'Hello.', done: true, usage: { inputTokens: 4, outputTokens: 2 } }]),
    )

    expect(await drainChunks(model)).toStrictEqual([
      { text: 'Hello.', done: false },
      { text: '', done: true, usage: { inputTokens: 4, outputTokens: 2 } },
    ])
  })

  it('omits the usage key when the provider reported none', async () => {
    const model = withPlainText(modelOf([{ text: 'Hello.', done: true }]))

    expect((await drainChunks(model)).at(-1)).toStrictEqual({ text: '', done: true })
  })

  it('ends the stream on the final chunk and drops anything after it', async () => {
    const model = withPlainText(
      modelOf([
        { text: 'Hello.', done: true },
        { text: ' Late.', done: false },
      ]),
    )

    expect(await drainChunks(model)).toStrictEqual([
      { text: 'Hello.', done: false },
      { text: '', done: true },
    ])
  })

  it('passes the inner kind and label through', () => {
    const inner = modelOf([])
    const model = withPlainText(inner)

    expect(model.kind).toBe(inner.kind)
    expect(model.label).toBe(inner.label)
  })

  it('forwards dispose to the inner model', async () => {
    const inner = modelOf([])
    const dispose = vi.fn()
    const model = withPlainText({ ...inner, dispose })

    await model.dispose?.()

    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('keeps dispose defined and a no-op for an inner model without one', () => {
    const model = withPlainText(modelOf([]))

    expect(model.dispose?.()).toBeUndefined()
  })
})

describe('createMultiPersonaDriver wiring', () => {
  function twoTurnTask(): {
    readonly task: ReturnType<typeof multiPersonaTask>
    readonly contexts: RoutingContext[]
    readonly events: SessionEvent[]
  } {
    return { task: multiPersonaTask(), contexts: [], events: [] }
  }

  function driverFor(
    task: ReturnType<typeof multiPersonaTask>,
    contexts: RoutingContext[],
    onContext: boolean,
    policy?: 'det-persona' | 'fixed-rotation',
  ) {
    const prompts = resolveSessionPrompts(task, DATE)
    const models = prompts.map(() =>
      modelOf([
        { text: 'Okay. ', done: false },
        { text: '', done: true },
      ]),
    )
    return createMultiPersonaDriver({
      task,
      prompts,
      models,
      clock: new FakeClock(0),
      locale: 'en',
      ...(policy === undefined ? {} : { policy }),
      ...(onContext ? { onContext: (context: RoutingContext) => contexts.push(context) } : {}),
    })
  }

  it('rejects a task without a session block', () => {
    const task = sessionTask({ session: undefined } as never)

    expect(() =>
      createMultiPersonaDriver({
        task,
        prompts: [],
        models: [],
        clock: new FakeClock(0),
        locale: 'en',
      }),
    ).toThrow(SessionTaskError)
    expect(() =>
      createMultiPersonaDriver({
        task,
        prompts: [],
        models: [],
        clock: new FakeClock(0),
        locale: 'en',
      }),
    ).toThrow(`task ${task.id} has no session`)
  })

  it('runs a turn without an onContext callback', async () => {
    const task = twoTurnTask().task
    const driver = driverFor(task, [], false)
    const events = collectEvents(driver)

    await driver.start()
    await driver.send('Katherine, what ships on Friday?')
    await driver.close()

    expect((await events).some((event) => event.type === 'persona.response.committed')).toBe(true)
  })

  it('publishes a context of committed transcript turns without system prompts', async () => {
    const { task, contexts } = twoTurnTask()
    const driver = driverFor(task, contexts, true)
    const events = collectEvents(driver)

    await driver.start()
    await driver.send('Katherine, what ships on Friday?')
    await driver.close()
    await events

    expect(contexts).toHaveLength(1)
    const transcript = contexts[0]?.transcript ?? []
    expect(transcript.map((entry) => entry.speaker.kind)).toStrictEqual(['persona', 'user'])
    expect(transcript.at(-1)).toStrictEqual({
      speaker: { kind: 'user' },
      text: 'Katherine, what ships on Friday?',
    })
    expect(transcript.every((entry) => !entry.text.includes('Instructions'))).toBe(true)
  })

  it('names the speaking persona on earlier assistant transcript turns', async () => {
    const base = multiPersonaTask()
    const task = {
      ...base,
      session: {
        ...base.session,
        scriptedUserTurns: [
          'Can you be specific about what is moving out of Friday’s release?',
          'Sam, how much of the notification work is already finished?',
          'Katherine, is that the priority you want?',
        ],
      },
    } as ReturnType<typeof multiPersonaTask>
    const contexts: RoutingContext[] = []
    const driver = driverFor(task, contexts, true)
    const events = collectEvents(driver)

    await driver.start()
    for (const turn of task.session?.scriptedUserTurns ?? []) await driver.send(turn)
    await driver.close()
    await events

    expect(contexts).toHaveLength(3)
    const finalTranscript = contexts[2]?.transcript ?? []
    expect(finalTranscript.map((entry) => entry.speaker.kind)).toEqual([
      'persona',
      'user',
      'persona',
      'user',
      'persona',
      'user',
    ])
    const personaIds = finalTranscript
      .filter((entry) => entry.speaker.kind === 'persona')
      .map((entry) => (entry.speaker as { personaId: string }).personaId)
    expect(personaIds).toStrictEqual(['manager', 'manager', 'peer'])
  })

  it('uses the det-persona control arm by default', async () => {
    const task = twoTurnTask().task
    const driver = driverFor(task, [], false)
    const events = collectEvents(driver)

    await driver.start()
    await driver.send('Katherine, what ships on Friday?')
    await driver.close()
    const granted = (await events)
      .filter((event) => event.type === 'turn.granted')
      .map((event) => (event.payload as { grant: { personaId: string } }).grant.personaId)

    expect(granted).toStrictEqual(['manager', 'manager'])
  })

  it('uses the fixed rotation when the run asks for the baseline arm', async () => {
    const task = twoTurnTask().task
    const driver = driverFor(task, [], false, 'fixed-rotation')
    const events = collectEvents(driver)

    await driver.start()
    await driver.send('Katherine, what ships on Friday?')
    await driver.close()
    const granted = (await events)
      .filter((event) => event.type === 'turn.granted')
      .map((event) => (event.payload as { grant: { personaId: string } }).grant.personaId)

    expect(granted).toStrictEqual(['manager', 'peer'])
  })
})

describe('createMultiPersonaDriver seed', () => {
  it('derives the arbiter tie-break seed from the task id', async () => {
    const base = multiPersonaTask()
    const task = {
      ...base,
      id: 'en-multi-seed-006',
      session: {
        ...base.session,
        scriptedUserTurns: ['Katherine Brooks and Sam Carter, what ships on Friday?'],
      },
    } as ReturnType<typeof multiPersonaTask>
    const prompts = resolveSessionPrompts(task, DATE)
    let greetingCalls = 0
    const failing: TextModelPort = {
      kind: 'live',
      label: 'failing-greeting',
      async *complete() {
        greetingCalls += 1
        if (greetingCalls === 1) throw new Error('greeting failed')
        yield { text: 'Okay. ', done: false }
        yield { text: '', done: true }
      },
    }
    const models = [
      failing,
      modelOf([
        { text: 'Okay. ', done: false },
        { text: '', done: true },
      ]),
    ]
    const driver = createMultiPersonaDriver({
      task,
      prompts,
      models,
      clock: new FakeClock(0),
      locale: 'en',
    })
    const events = collectEvents(driver)

    await driver.start()
    await driver.send(task.session?.scriptedUserTurns[0] ?? '')
    await driver.close()
    const granted = (await events)
      .filter((event) => event.type === 'turn.granted')
      .map((event) => (event.payload as { grant: { personaId: string } }).grant.personaId)

    expect(granted).toStrictEqual(['manager', 'manager'])
  })
})
