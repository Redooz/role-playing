import {
  TRANSCRIPT_SCHEMA_VERSION,
  buildSessionLogRecord,
  createTextSessionDriver,
  sessionLogHeaderLine,
  sessionLogRecordLine,
  type SessionEvent,
  type SessionLogHeader,
  type TextModelChunk,
  type TextModelPort,
  type TextModelRequest,
} from '@rp/session-core'
import { FakeClock } from '@rp/shared'
import { describe, expect, it } from 'vitest'
import { runCli, type CliIo, type CliLog } from './cli-main.js'

interface ScriptedModel extends TextModelPort {
  readonly requests: TextModelRequest[]
}

function scriptedModel(
  chunks: readonly string[],
  options: { onFirstChunk?: () => void; slowAfterFirst?: boolean } = {},
): ScriptedModel {
  const requests: TextModelRequest[] = []

  return {
    kind: 'canned',
    label: 'scripted',
    requests,
    async *complete(request, completeOptions): AsyncIterable<TextModelChunk> {
      requests.push(request)
      for (const [index, text] of chunks.entries()) {
        if (index > 0) {
          if (options.slowAfterFirst === true) {
            await new Promise((resolve) => setTimeout(resolve, 20))
          } else {
            await Promise.resolve()
          }
        }
        if (completeOptions?.signal?.aborted === true) return
        yield { text, done: index === chunks.length - 1 }
        if (index === 0) options.onFirstChunk?.()
      }
    },
  }
}

function captureIo(): { io: CliIo; text: () => string; errors: string[] } {
  const chunks: string[] = []
  const errors: string[] = []
  return {
    io: {
      write: (text) => void chunks.push(text),
      out: (line) => void chunks.push(`${line}\n`),
      err: (line) => void errors.push(line),
    },
    text: () => chunks.join(''),
    errors,
  }
}

async function* linesOf(...input: readonly string[]): AsyncIterable<string> {
  for (const line of input) yield line
}

function driverWith(model: TextModelPort, options: { grantTtlMs?: number } = {}) {
  return createTextSessionDriver({
    sessionId: 'session-1',
    lang: 'en',
    clock: new FakeClock(0),
    model,
    grantTtlMs: options.grantTtlMs,
  })
}

function memoryLog(): { log: CliLog; events: SessionEvent[] } {
  const events: SessionEvent[] = []
  return {
    events,
    log: {
      async append(event) {
        events.push(event)
      },
    },
  }
}

const header: SessionLogHeader = {
  type: 'session.header',
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  sessionId: 'session-1',
  startedAt: '2026-11-07T10:00:00.000Z',
  clockMode: 'simulated',
  lang: 'en',
  provider: 'canned/demo',
}

function logText(events: readonly SessionEvent[]): string {
  const records = events.map((event, seq) =>
    buildSessionLogRecord({ header, event, seq, tSim: seq, tWall: 0 }),
  )
  return `${[sessionLogHeaderLine(header), ...records.map(sessionLogRecordLine)].join('\n')}\n`
}

describe('text session CLI', () => {
  it('prints the provider mode, the session id and the streamed reply', async () => {
    const io = captureIo()
    const model = scriptedModel(['Hello ', 'there'])
    const { log, events } = memoryLog()

    await runCli({
      input: linesOf('hello'),
      io: io.io,
      driver: driverWith(model),
      provider: { kind: 'canned', label: 'canned/demo' },
      log,
      logPath: 'sessions/session-1.jsonl',
    })

    const output = io.text()
    expect(output).toContain('provider: canned (canned/demo)')
    expect(output).toContain('session: session-1')
    expect(output).toContain('log: sessions/session-1.jsonl')
    expect(output).toContain('you> hello')
    expect(output).toContain('persona> Hello there')
    expect(events.map((event) => event.type)).toEqual([
      'session.started',
      'user.utterance.committed',
      'turn.opened',
      'turn.granted',
      'persona.response.started',
      'persona.response.chunk',
      'persona.response.chunk',
      'persona.response.committed',
      'session.completed',
    ])
  })

  it('answers /help without calling the model', async () => {
    const io = captureIo()
    const model = scriptedModel(['unused'])

    await runCli({
      input: linesOf('/help'),
      io: io.io,
      driver: driverWith(model),
      provider: { kind: 'canned', label: 'canned/demo' },
    })

    expect(io.text()).toContain('commands:')
    expect(io.text()).toContain('/interrupt')
    expect(io.text()).toContain('/replay <file>')
    expect(model.requests).toHaveLength(0)
  })

  it('closes on /quit and writes session.completed', async () => {
    const io = captureIo()
    const { log, events } = memoryLog()

    await runCli({
      input: linesOf('/quit'),
      io: io.io,
      driver: driverWith(scriptedModel(['unused'])),
      provider: { kind: 'canned', label: 'canned/demo' },
      log,
    })

    expect(events.map((event) => event.type)).toEqual(['session.started', 'session.completed'])
  })

  it('interrupts a reply in flight and keeps the partial text', async () => {
    const io = captureIo()
    let firstChunk: () => void = () => undefined
    const sawFirstChunk = new Promise<void>((resolve) => {
      firstChunk = resolve
    })
    const model = scriptedModel(['One ', 'two'], {
      onFirstChunk: firstChunk,
      slowAfterFirst: true,
    })
    const { log, events } = memoryLog()

    async function* input(): AsyncIterable<string> {
      yield 'hello'
      await sawFirstChunk
      yield '/interrupt'
    }

    await runCli({
      input: input(),
      io: io.io,
      driver: driverWith(model),
      provider: { kind: 'canned', label: 'canned/demo' },
      log,
    })

    expect(io.text()).toContain('persona> One ')
    expect(io.text()).toContain('[cancelled: interrupted]')
    const cancelled = events.find((event) => event.type === 'persona.response.cancelled')
    expect(cancelled?.payload).toMatchObject({ reason: 'interrupted', partialText: 'One ' })
  })

  it('treats an unknown slash line as an utterance', async () => {
    const model = scriptedModel(['ok'])
    const io = captureIo()

    await runCli({
      input: linesOf('/not-a-command'),
      io: io.io,
      driver: driverWith(model),
      provider: { kind: 'canned', label: 'canned/demo' },
    })

    expect(model.requests[0]?.messages).toEqual([{ role: 'user', content: '/not-a-command' }])
  })

  it('prints a saved session with /replay', async () => {
    const io = captureIo()
    const saved = logText([
      {
        type: 'session.started',
        payload: { sessionId: 'session-1', clockMode: 'simulated', lang: 'en' },
      },
      { type: 'user.utterance.committed', payload: { text: 'hello' } },
      { type: 'persona.response.committed', payload: { grantId: 'grant-1', text: 'Hello there' } },
      { type: 'session.completed', payload: {} },
    ])

    await runCli({
      input: linesOf('/replay /tmp/session.jsonl'),
      io: io.io,
      driver: driverWith(scriptedModel(['unused'])),
      provider: { kind: 'canned', label: 'canned/demo' },
      readFile: async () => saved,
    })

    expect(io.text()).toContain('session session-1')
    expect(io.text()).toContain('you> hello')
    expect(io.text()).toContain('persona> Hello there')
    expect(io.text()).toContain('session completed')
  })

  it('reports an empty committed reply without a bare prompt', async () => {
    const io = captureIo()
    const model: TextModelPort = {
      kind: 'canned',
      label: 'empty',
      async *complete() {
        yield { text: '', done: true }
      },
    }

    await runCli({
      input: linesOf('hello'),
      io: io.io,
      driver: driverWith(model),
      provider: { kind: 'canned', label: 'canned/demo' },
    })

    expect(io.text()).toContain('persona> [empty response]')
    expect(io.text()).not.toContain('persona> \n')
  })

  it('reports an immediate cancellation without a bare prompt', async () => {
    const io = captureIo()
    const model: TextModelPort = {
      kind: 'canned',
      label: 'hanging',
      complete() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<TextModelChunk>> {
                return new Promise(() => undefined)
              },
            }
          },
        }
      },
    }

    await runCli({
      input: linesOf('hello', '/interrupt'),
      io: io.io,
      driver: driverWith(model),
      provider: { kind: 'canned', label: 'canned/demo' },
    })

    expect(io.text()).toContain('[cancelled: interrupted]')
    expect(io.text()).not.toContain('persona> \n')
  })

  it('reports a provider failure without printing a partial persona line', async () => {
    const io = captureIo()
    const model: TextModelPort = {
      kind: 'canned',
      label: 'failing',
      complete() {
        throw new Error('boom')
      },
    }

    await runCli({
      input: linesOf('hello'),
      io: io.io,
      driver: driverWith(model),
      provider: { kind: 'canned', label: 'canned/demo' },
    })

    expect(io.text()).toContain('[cancelled: provider failure]')
    expect(io.text()).not.toContain('persona> \n')
  })

  it('reports a grant timeout', async () => {
    const io = captureIo()
    const model: TextModelPort = {
      kind: 'canned',
      label: 'silent',
      complete() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<TextModelChunk>> {
                return new Promise(() => undefined)
              },
            }
          },
        }
      },
    }

    await runCli({
      input: linesOf('hello'),
      io: io.io,
      driver: driverWith(model, { grantTtlMs: 10 }),
      provider: { kind: 'canned', label: 'canned/demo' },
    })

    expect(io.text()).toContain('[cancelled: timeout]')
  })

  it('reports a log write failure once and keeps the session running', async () => {
    const io = captureIo()
    let calls = 0

    await runCli({
      input: linesOf('/help', 'hello'),
      io: io.io,
      driver: driverWith(scriptedModel(['ok'])),
      provider: { kind: 'canned', label: 'canned/demo' },
      log: {
        async append() {
          calls += 1
          throw new Error('disk full')
        },
      },
    })

    expect(calls).toBeGreaterThan(1)
    expect(io.errors).toHaveLength(1)
    expect(io.errors[0]).toContain('log write failed: disk full')
  })

  it('reports a replay failure without closing the session', async () => {
    const io = captureIo()
    const { log, events } = memoryLog()

    await runCli({
      input: linesOf('/replay /tmp/missing.jsonl', '/quit'),
      io: io.io,
      driver: driverWith(scriptedModel(['unused'])),
      provider: { kind: 'canned', label: 'canned/demo' },
      log,
      readFile: async () => {
        throw new Error('no such file')
      },
    })

    expect(io.errors[0]).toContain('replay failed: no such file')
    expect(events.at(-1)?.type).toBe('session.completed')
  })
})
