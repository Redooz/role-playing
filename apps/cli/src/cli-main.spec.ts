import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TRANSCRIPT_SCHEMA_VERSION,
  buildSessionLogRecord,
  createTextSessionDriver,
  sessionLogHeaderLine,
  sessionLogRecordLine,
  type SessionDriver,
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

function captureIoWithWrites() {
  const base = captureIo()
  const writes: string[] = []
  return {
    ...base,
    writes,
    io: {
      ...base.io,
      write: (text: string) => {
        writes.push(text)
        base.io.write(text)
      },
    },
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
      selection: {
        personaId: 'manager',
        personaName: 'Katherine Brooks',
        scenarioId: 'request-deadline-extension',
        locale: 'en-GB',
      },
    })

    const output = io.text()
    expect(output).toContain('provider: canned (canned/demo)')
    expect(output).toContain('session: session-1')
    expect(output).toContain('log: sessions/session-1.jsonl')
    expect(output).toContain(
      'persona: Katherine Brooks (manager), scenario: request-deadline-extension, locale: en-GB',
    )
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

  it('marks a log without session.completed as unterminated and shows partial text', async () => {
    const io = captureIo()
    const saved = logText([
      {
        type: 'session.started',
        payload: { sessionId: 'session-1', clockMode: 'simulated', lang: 'en' },
      },
      { type: 'user.utterance.committed', payload: { text: 'hello' } },
      {
        type: 'persona.response.chunk',
        payload: { grantId: 'grant-1', text: 'Half a rep', sequence: 0 },
      },
    ])

    await runCli({
      input: linesOf('/replay /tmp/crashed.jsonl'),
      io: io.io,
      driver: driverWith(scriptedModel(['unused'])),
      provider: { kind: 'canned', label: 'canned/demo' },
      readFile: async () => saved,
    })

    expect(io.text()).toContain('persona> Half a rep [unfinished]')
    expect(io.text()).toContain('[unterminated')
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

  it('replays through the default file reader', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-replay-'))
    const path = join(dir, 'session.jsonl')
    const saved = logText([
      {
        type: 'session.started',
        payload: { sessionId: 'session-1', clockMode: 'simulated', lang: 'en' },
      },
      { type: 'session.completed', payload: {} },
    ])
    await writeFile(path, saved, 'utf8')
    const io = captureIo()
    try {
      await runCli({
        input: linesOf(`/replay    ${path}`),
        io: io.io,
        driver: driverWith(scriptedModel(['unused'])),
        provider: { kind: 'canned', label: 'canned/demo' },
      })
      expect(io.text()).toContain('session session-1')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports /replay without a file and ignores blank input lines', async () => {
    const io = captureIo()
    const model = scriptedModel(['unused'])

    await runCli({
      input: linesOf('', '   ', '/replay'),
      io: io.io,
      driver: driverWith(model),
      provider: { kind: 'canned', label: 'canned/demo' },
    })

    expect(io.errors).toContain('usage: /replay <file>')
    expect(model.requests).toHaveLength(0)
  })

  it('strips a carriage return from an input line', async () => {
    const io = captureIo()
    const model = scriptedModel(['ok'])

    await runCli({
      input: linesOf('hello\r'),
      io: io.io,
      driver: driverWith(model),
      provider: { kind: 'canned', label: 'canned/demo' },
    })

    expect(model.requests[0]?.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('reports a send rejection and still closes the driver', async () => {
    const io = captureIo()
    let closed = 0
    const driver: SessionDriver = {
      sessionId: 'fake',
      events: (async function* () {
        yield* []
      })() as AsyncIterable<SessionEvent>,
      async start() {},
      async send() {
        throw new Error('send broke')
      },
      async interrupt() {},
      async close() {
        closed += 1
      },
    }

    await runCli({
      input: linesOf('hello'),
      io: io.io,
      driver,
      provider: { kind: 'canned', label: 'canned/demo' },
    })

    expect(io.errors[0]).toContain('send failed: send broke')
    expect(closed).toBe(1)
  })

  it('renders every cancellation reason and newline-closes an open prompt', async () => {
    const reasons = [
      ['provider_failure', 'provider failure'],
      ['interrupted', 'interrupted'],
      ['timeout', 'timeout'],
      ['user_barge_in', 'user barge-in'],
      ['revoked', 'grant revoked'],
    ] as const
    for (const [reason, label] of reasons) {
      const io = captureIo()
      const driver: SessionDriver = {
        sessionId: 'fake',
        events: (async function* () {
          yield {
            type: 'persona.response.chunk',
            payload: { grantId: 'grant-1', text: 'Half', sequence: 0 },
          }
          yield {
            type: 'persona.response.cancelled',
            payload: { grantId: 'grant-1', reason },
          }
          yield { type: 'session.completed', payload: {} }
        })() as AsyncIterable<SessionEvent>,
        async start() {},
        async send() {},
        async interrupt() {},
        async close() {},
      }
      await runCli({
        input: linesOf('hello'),
        io: io.io,
        driver,
        provider: { kind: 'canned', label: 'canned/demo' },
      })
      expect(io.text()).toContain(`[cancelled: ${label}]`)
    }
  })

  it('prints replay cancelled turns with and without partial text', async () => {
    const io = captureIo()
    const saved = logText([
      {
        type: 'session.started',
        payload: { sessionId: 'session-1', clockMode: 'simulated', lang: 'en' },
      },
      {
        type: 'persona.response.cancelled',
        payload: { grantId: 'grant-1', reason: 'interrupted', partialText: 'Half' },
      },
      {
        type: 'persona.response.cancelled',
        payload: { grantId: 'grant-2', reason: 'timeout' },
      },
      { type: 'session.completed', payload: {} },
    ])

    await runCli({
      input: linesOf('/replay /tmp/cancelled.jsonl'),
      io: io.io,
      driver: driverWith(scriptedModel(['unused'])),
      provider: { kind: 'canned', label: 'canned/demo' },
      readFile: async () => saved,
    })

    expect(io.text()).toContain('persona> Half [cancelled: interrupted]')
    expect(io.text()).toContain('persona> [cancelled: timeout]')
  })

  it('reports truncation and does not print an empty unfinished chunk', async () => {
    const io = captureIo()
    const complete = logText([
      {
        type: 'session.started',
        payload: { sessionId: 'session-1', clockMode: 'simulated', lang: 'en' },
      },
      {
        type: 'persona.response.chunk',
        payload: { grantId: 'grant-1', text: '', sequence: 0 },
      },
    ])
    const truncated = `${complete.slice(0, complete.length - 5)}`

    await runCli({
      input: linesOf('/replay /tmp/truncated.jsonl'),
      io: io.io,
      driver: driverWith(scriptedModel(['unused'])),
      provider: { kind: 'canned', label: 'canned/demo' },
      readFile: async () => truncated,
    })

    expect(io.text()).toContain('[truncated:')
    expect(io.text()).not.toContain('[unfinished]')
  })

  it('omits the selection and log path when they are not provided', async () => {
    const io = captureIo()
    await runCli({
      input: linesOf('/quit'),
      io: io.io,
      driver: driverWith(scriptedModel(['unused'])),
      provider: { kind: 'canned', label: 'canned/demo' },
    })
    expect(io.text()).not.toContain('persona:')
    expect(io.text()).not.toContain('log:')
    expect(io.text()).toContain('type /help for commands')
  })

  it('prints every help line verbatim', async () => {
    const io = captureIo()
    await runCli({
      input: linesOf('/help'),
      io: io.io,
      driver: driverWith(scriptedModel(['unused'])),
      provider: { kind: 'canned', label: 'canned/demo' },
    })
    for (const line of [
      'commands:',
      '  /interrupt      stop the reply in flight',
      '  /replay <file>  print a saved session log',
      '  /quit           close the session and exit',
      '  /help           show this help',
      'any other line is sent to the persona',
    ]) {
      expect(io.text()).toContain(line)
    }
  })

  it('does not send blank or whitespace-only lines', async () => {
    const io = captureIo()
    const sent: string[] = []
    const driver: SessionDriver = {
      sessionId: 'fake',
      events: (async function* () {
        yield* []
      })() as AsyncIterable<SessionEvent>,
      async start() {},
      async send(text) {
        sent.push(text)
      },
      async interrupt() {},
      async close() {},
    }
    await runCli({
      input: linesOf('', '   ', '\t', '/quit'),
      io: io.io,
      driver,
      provider: { kind: 'canned', label: 'canned/demo' },
    })
    expect(sent).toEqual([])
  })

  it('keeps an interior carriage return', async () => {
    const io = captureIo()
    const sent: string[] = []
    const driver: SessionDriver = {
      sessionId: 'fake',
      events: (async function* () {
        yield* []
      })() as AsyncIterable<SessionEvent>,
      async start() {},
      async send(text) {
        sent.push(text)
      },
      async interrupt() {},
      async close() {},
    }
    await runCli({
      input: linesOf('hel\rlo', '/quit'),
      io: io.io,
      driver,
      provider: { kind: 'canned', label: 'canned/demo' },
    })
    expect(sent).toEqual(['hel\rlo'])
  })

  it('closes exactly once on /quit', async () => {
    const io = captureIo()
    let closes = 0
    const driver: SessionDriver = {
      sessionId: 'fake',
      events: (async function* () {
        yield* []
      })() as AsyncIterable<SessionEvent>,
      async start() {},
      async send() {},
      async interrupt() {},
      async close() {
        closes += 1
      },
    }
    await runCli({
      input: linesOf('/quit'),
      io: io.io,
      driver,
      provider: { kind: 'canned', label: 'canned/demo' },
    })
    expect(closes).toBe(1)
  })

  it('starts a fresh persona prompt after each committed reply', async () => {
    const io = captureIo()
    const driver: SessionDriver = {
      sessionId: 'fake',
      events: (async function* () {
        yield {
          type: 'persona.response.chunk',
          payload: { grantId: 'g1', text: 'One', sequence: 0 },
        }
        yield {
          type: 'persona.response.committed',
          payload: { grantId: 'g1', text: 'One' },
        }
        yield {
          type: 'persona.response.chunk',
          payload: { grantId: 'g2', text: 'Two', sequence: 0 },
        }
        yield {
          type: 'persona.response.committed',
          payload: { grantId: 'g2', text: 'Two' },
        }
      })() as AsyncIterable<SessionEvent>,
      async start() {},
      async send() {},
      async interrupt() {},
      async close() {},
    }
    await runCli({
      input: linesOf('hello'),
      io: io.io,
      driver,
      provider: { kind: 'canned', label: 'canned/demo' },
    })
    expect(io.text().match(/persona> /g)).toHaveLength(2)
    expect(io.text()).toContain('One\n')
    expect(io.text()).toContain('Two\n')
  })

  it('starts a fresh persona prompt after an empty committed reply', async () => {
    const io = captureIo()
    const driver: SessionDriver = {
      sessionId: 'fake',
      events: (async function* () {
        yield {
          type: 'persona.response.committed',
          payload: { grantId: 'g1', text: '' },
        }
        yield {
          type: 'persona.response.chunk',
          payload: { grantId: 'g2', text: 'Two', sequence: 0 },
        }
      })() as AsyncIterable<SessionEvent>,
      async start() {},
      async send() {},
      async interrupt() {},
      async close() {},
    }
    await runCli({
      input: linesOf('hello'),
      io: io.io,
      driver,
      provider: { kind: 'canned', label: 'canned/demo' },
    })
    expect(io.text()).toContain('persona> [empty response]')
    expect(io.text().match(/persona> /g)).toHaveLength(2)
  })

  it('newline-closes an open prompt when the session completes', async () => {
    const io = captureIo()
    const driver: SessionDriver = {
      sessionId: 'fake',
      events: (async function* () {
        yield {
          type: 'persona.response.chunk',
          payload: { grantId: 'g1', text: 'Half', sequence: 0 },
        }
        yield { type: 'session.completed', payload: {} }
      })() as AsyncIterable<SessionEvent>,
      async start() {},
      async send() {},
      async interrupt() {},
      async close() {},
    }
    await runCli({
      input: linesOf('hello'),
      io: io.io,
      driver,
      provider: { kind: 'canned', label: 'canned/demo' },
    })
    expect(io.text()).toContain('Half\n')
  })

  it('newline-closes an open prompt before a cancellation', async () => {
    const io = captureIo()
    const driver: SessionDriver = {
      sessionId: 'fake',
      events: (async function* () {
        yield {
          type: 'persona.response.chunk',
          payload: { grantId: 'g1', text: 'Half', sequence: 0 },
        }
        yield {
          type: 'persona.response.cancelled',
          payload: { grantId: 'g1', reason: 'interrupted' },
        }
      })() as AsyncIterable<SessionEvent>,
      async start() {},
      async send() {},
      async interrupt() {},
      async close() {},
    }
    await runCli({
      input: linesOf('hello'),
      io: io.io,
      driver,
      provider: { kind: 'canned', label: 'canned/demo' },
    })
    expect(io.text()).toContain('Half\n[cancelled: interrupted]')
  })

  it('does not print an empty unfinished chunk on replay', async () => {
    const io = captureIo()
    const saved = logText([
      {
        type: 'session.started',
        payload: { sessionId: 'session-1', clockMode: 'simulated', lang: 'en' },
      },
      {
        type: 'persona.response.chunk',
        payload: { grantId: 'grant-1', text: '', sequence: 0 },
      },
    ])
    await runCli({
      input: linesOf('/replay /tmp/empty.jsonl'),
      io: io.io,
      driver: driverWith(scriptedModel(['unused'])),
      provider: { kind: 'canned', label: 'canned/demo' },
      readFile: async () => saved,
    })
    expect(io.text()).toContain('[unterminated:')
    expect(io.text()).not.toContain('[unfinished]')
  })

  it('does not write a newline before a cancellation with no open prompt', async () => {
    const io = captureIoWithWrites()
    const driver: SessionDriver = {
      sessionId: 'fake',
      events: (async function* () {
        yield {
          type: 'persona.response.cancelled',
          payload: { grantId: 'g1', reason: 'interrupted' },
        }
        yield {
          type: 'persona.response.cancelled',
          payload: { grantId: 'g2', reason: 'timeout' },
        }
      })() as AsyncIterable<SessionEvent>,
      async start() {},
      async send() {},
      async interrupt() {},
      async close() {},
    }
    await runCli({
      input: linesOf('hello'),
      io: io.io,
      driver,
      provider: { kind: 'canned', label: 'canned/demo' },
    })
    expect(io.writes).not.toContain('\n')
    expect(io.text()).toContain('[cancelled: interrupted]')
    expect(io.text()).toContain('[cancelled: timeout]')
  })

  it('does not write a newline for session.completed with no open prompt', async () => {
    const io = captureIoWithWrites()
    const driver: SessionDriver = {
      sessionId: 'fake',
      events: (async function* () {
        yield { type: 'session.completed', payload: {} }
      })() as AsyncIterable<SessionEvent>,
      async start() {},
      async send() {},
      async interrupt() {},
      async close() {},
    }
    await runCli({
      input: linesOf('hello'),
      io: io.io,
      driver,
      provider: { kind: 'canned', label: 'canned/demo' },
    })
    expect(io.writes).not.toContain('\n')
  })

  it('does not report log errors when no log is configured', async () => {
    const io = captureIo()
    await runCli({
      input: linesOf('/help'),
      io: io.io,
      driver: driverWith(scriptedModel(['unused'])),
      provider: { kind: 'canned', label: 'canned/demo' },
    })
    expect(io.errors).toEqual([])
    expect(io.text()).not.toContain('Stryker was here!')
  })

  it('does not print truncation or unterminated markers for a complete replay', async () => {
    const io = captureIo()
    const saved = logText([
      {
        type: 'session.started',
        payload: { sessionId: 'session-1', clockMode: 'simulated', lang: 'en' },
      },
      { type: 'session.completed', payload: {} },
    ])
    await runCli({
      input: linesOf('/replay /tmp/complete.jsonl'),
      io: io.io,
      driver: driverWith(scriptedModel(['unused'])),
      provider: { kind: 'canned', label: 'canned/demo' },
      readFile: async () => saved,
    })
    expect(io.text()).not.toContain('[truncated:')
    expect(io.text()).not.toContain('[unterminated:')
  })

  it('does not print a cancelled grant as unfinished after replay', async () => {
    const io = captureIo()
    const saved = logText([
      {
        type: 'session.started',
        payload: { sessionId: 'session-1', clockMode: 'simulated', lang: 'en' },
      },
      {
        type: 'persona.response.chunk',
        payload: { grantId: 'grant-1', text: 'Half', sequence: 0 },
      },
      {
        type: 'persona.response.cancelled',
        payload: { grantId: 'grant-1', reason: 'interrupted', partialText: 'Half' },
      },
    ])
    await runCli({
      input: linesOf('/replay /tmp/cancelled-open.jsonl'),
      io: io.io,
      driver: driverWith(scriptedModel(['unused'])),
      provider: { kind: 'canned', label: 'canned/demo' },
      readFile: async () => saved,
    })
    expect(io.text()).toContain('[cancelled: interrupted]')
    expect(io.text()).not.toContain('[unfinished]')
  })

  it('does not print an earlier committed grant as unfinished after replay', async () => {
    const io = captureIo()
    const saved = logText([
      {
        type: 'session.started',
        payload: { sessionId: 'session-1', clockMode: 'simulated', lang: 'en' },
      },
      {
        type: 'persona.response.chunk',
        payload: { grantId: 'grant-1', text: 'Done', sequence: 0 },
      },
      {
        type: 'persona.response.committed',
        payload: { grantId: 'grant-1', text: 'Done' },
      },
      {
        type: 'persona.response.cancelled',
        payload: { grantId: 'grant-2', reason: 'timeout' },
      },
    ])
    await runCli({
      input: linesOf('/replay /tmp/committed-open.jsonl'),
      io: io.io,
      driver: driverWith(scriptedModel(['unused'])),
      provider: { kind: 'canned', label: 'canned/demo' },
      readFile: async () => saved,
    })
    expect(io.text()).toContain('persona> Done')
    expect(io.text()).not.toContain('Done [unfinished]')
  })
})

describe('multi-persona CLI labels', () => {
  it('prints one speaker label per grant and keeps a single log', async () => {
    const io = captureIo()
    const { log, events } = memoryLog()
    const stream: SessionEvent[] = [
      {
        type: 'session.started',
        payload: { sessionId: 'multi-1', clockMode: 'simulated', lang: 'en' },
      },
      {
        type: 'turn.granted',
        payload: {
          grant: {
            turnId: 'turn-1',
            grantId: 'grant-1',
            personaId: 'manager',
            expiresAt: '2026-11-07T10:01:00.000Z',
          },
        },
      },
      { type: 'persona.response.started', payload: { grantId: 'grant-1' } },
      {
        type: 'persona.response.chunk',
        payload: { grantId: 'grant-1', text: 'Hello', sequence: 0 },
      },
      {
        type: 'persona.response.committed',
        payload: { grantId: 'grant-1', text: 'Hello' },
      },
      {
        type: 'turn.granted',
        payload: {
          grant: {
            turnId: 'turn-2',
            grantId: 'grant-2',
            personaId: 'peer',
            expiresAt: '2026-11-07T10:02:00.000Z',
          },
        },
      },
      { type: 'persona.response.started', payload: { grantId: 'grant-2' } },
      { type: 'persona.response.chunk', payload: { grantId: 'grant-2', text: 'Hi', sequence: 0 } },
      { type: 'persona.response.committed', payload: { grantId: 'grant-2', text: 'Hi' } },
      { type: 'session.completed', payload: {} },
    ]
    const driver: SessionDriver = {
      sessionId: 'multi-1',
      events: (async function* () {
        yield* stream
      })(),
      async start() {},
      async send() {},
      async interrupt() {},
      async close() {},
    }

    await runCli({
      input: linesOf('/quit'),
      io: io.io,
      driver,
      provider: { kind: 'canned', label: 'canned/demo' },
      log,
      selection: {
        personaId: 'manager',
        personaName: 'Katherine Brooks',
        scenarioId: 'standup-scope-change',
        locale: 'en',
        personas: [
          { personaId: 'manager', personaName: 'Katherine Brooks' },
          { personaId: 'peer', personaName: 'Sam Carter' },
        ],
      },
    })

    const output = io.text()
    expect(output).toContain(
      'personas: manager (Katherine Brooks), peer (Sam Carter), scenario: standup-scope-change, locale: en',
    )
    expect(output).toContain('[manager] Hello')
    expect(output).toContain('[peer] Hi')
    expect(output).not.toContain('persona>')
    expect(events.filter((event) => event.type === 'persona.response.committed')).toHaveLength(2)
    expect(
      events.filter((event) => event.type === 'turn.granted').map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({ grant: expect.objectContaining({ personaId: 'manager' }) }),
      expect.objectContaining({ grant: expect.objectContaining({ personaId: 'peer' }) }),
    ])
  })
})

describe('speaker label edge cases', () => {
  function fakeDriver(stream: readonly SessionEvent[]): SessionDriver {
    return {
      sessionId: 'session-1',
      events: (async function* () {
        yield* stream
      })(),
      async start() {},
      async send() {},
      async interrupt() {},
      async close() {},
    }
  }

  it('keeps the single-persona presentation when one persona is named in the selection', async () => {
    const io = captureIo()
    await runCli({
      input: linesOf('/quit'),
      io: io.io,
      driver: fakeDriver([
        {
          type: 'session.started',
          payload: { sessionId: 'session-1', clockMode: 'simulated', lang: 'en' },
        },
        {
          type: 'turn.granted',
          payload: {
            grant: {
              turnId: 'turn-1',
              grantId: 'grant-1',
              personaId: 'manager',
              expiresAt: '2026-11-07T10:01:00.000Z',
            },
          },
        },
        {
          type: 'persona.response.chunk',
          payload: { grantId: 'grant-1', text: 'Hello', sequence: 0 },
        },
        { type: 'persona.response.committed', payload: { grantId: 'grant-1', text: 'Hello' } },
      ]),
      provider: { kind: 'canned', label: 'canned/demo' },
      selection: {
        personaId: 'manager',
        personaName: 'Katherine Brooks',
        scenarioId: 'standup-scope-change',
        locale: 'en',
        personas: [{ personaId: 'manager', personaName: 'Katherine Brooks' }],
      },
    })

    expect(io.text()).toContain('persona: Katherine Brooks (manager)')
    expect(io.text()).toContain('persona> Hello')
    expect(io.text()).not.toContain('[manager]')
  })

  it('labels an unknown grant and a cancelled multi-persona turn defensively', async () => {
    const io = captureIo()
    await runCli({
      input: linesOf('/quit'),
      io: io.io,
      driver: fakeDriver([
        {
          type: 'session.started',
          payload: { sessionId: 'session-1', clockMode: 'simulated', lang: 'en' },
        },
        {
          type: 'persona.response.chunk',
          payload: { grantId: 'ghost', text: 'Who?', sequence: 0 },
        },
        {
          type: 'persona.response.cancelled',
          payload: { grantId: 'ghost', reason: 'revoked', partialText: 'Who?' },
        },
        {
          type: 'turn.granted',
          payload: {
            grant: {
              turnId: 'turn-1',
              grantId: 'grant-1',
              personaId: 'manager',
              expiresAt: '2026-11-07T10:01:00.000Z',
            },
          },
        },
        { type: 'persona.response.started', payload: { grantId: 'grant-1' } },
        {
          type: 'persona.response.cancelled',
          payload: { grantId: 'grant-1', reason: 'interrupted' },
        },
      ]),
      provider: { kind: 'canned', label: 'canned/demo' },
      selection: {
        personaId: 'manager',
        personaName: 'Katherine Brooks',
        scenarioId: 'standup-scope-change',
        locale: 'en',
        personas: [
          { personaId: 'manager', personaName: 'Katherine Brooks' },
          { personaId: 'peer', personaName: 'Sam Carter' },
        ],
      },
    })

    expect(io.text()).toContain('[unknown] Who?')
    expect(io.text()).toContain('[manager] [cancelled: interrupted]')
  })

  it('replays a multi-persona log with speaker labels', async () => {
    const io = captureIo()
    const saved = logText([
      {
        type: 'session.started',
        payload: { sessionId: 'session-1', clockMode: 'simulated', lang: 'en' },
      },
      {
        type: 'turn.granted',
        payload: {
          grant: {
            turnId: 'turn-1',
            grantId: 'grant-1',
            personaId: 'manager',
            expiresAt: '2026-11-07T10:01:00.000Z',
          },
        },
      },
      {
        type: 'persona.response.chunk',
        payload: { grantId: 'grant-1', text: 'Hello', sequence: 0 },
      },
      { type: 'persona.response.committed', payload: { grantId: 'grant-1', text: 'Hello' } },
      {
        type: 'turn.granted',
        payload: {
          grant: {
            turnId: 'turn-2',
            grantId: 'grant-2',
            personaId: 'peer',
            expiresAt: '2026-11-07T10:02:00.000Z',
          },
        },
      },
      {
        type: 'persona.response.cancelled',
        payload: { grantId: 'grant-2', reason: 'interrupted', partialText: 'Hi' },
      },
      {
        type: 'persona.response.cancelled',
        payload: { grantId: 'ghost', reason: 'revoked', partialText: 'Who?' },
      },
      { type: 'session.completed', payload: {} },
    ])

    await runCli({
      input: linesOf('/replay /tmp/multi.jsonl'),
      io: io.io,
      driver: fakeDriver([]),
      provider: { kind: 'canned', label: 'canned/demo' },
      readFile: async () => saved,
      selection: {
        personaId: 'manager',
        personaName: 'Katherine Brooks',
        scenarioId: 'standup-scope-change',
        locale: 'en',
        personas: [
          { personaId: 'manager', personaName: 'Katherine Brooks' },
          { personaId: 'peer', personaName: 'Sam Carter' },
        ],
      },
    })

    expect(io.text()).toContain('[manager] Hello')
    expect(io.text()).toContain('[peer] Hi [cancelled: interrupted]')
    expect(io.text()).toContain('[unknown] Who? [cancelled: revoked]')
  })
})
