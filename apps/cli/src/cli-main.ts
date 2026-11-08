import { readFile } from 'node:fs/promises'
import {
  replaySessionLog,
  type SessionDriver,
  type SessionEvent,
  type SessionEventOf,
} from '@rp/session-core'

/**
 * Line REPL over the session driver (M1 D4).
 *
 * The CLI holds no session state. It maps lines to driver commands, prints
 * streamed text, and appends every event to the log. Input and output are
 * injected so tests never need a TTY.
 *
 * Only four lines are commands; every other line is a user utterance. That is
 * the declared contract, so a mistyped `/comand` reaches the persona rather
 * than being silently swallowed.
 */

export interface CliIo {
  /** Raw write, used for streamed text. */
  write(text: string): void
  /** Write one line. */
  out(line: string): void
  err(line: string): void
}

export interface CliLog {
  append(event: SessionEvent): Promise<void>
}

export interface CliProvider {
  readonly kind: 'canned' | 'live'
  /** Adapter label. Must never contain a secret. */
  readonly label: string
}

export interface RunCliOptions {
  readonly input: AsyncIterable<string>
  readonly io: CliIo
  readonly driver: SessionDriver
  readonly provider: CliProvider
  readonly log?: CliLog
  readonly logPath?: string
  /** Injected for tests; defaults to `node:fs/promises` readFile. */
  readonly readFile?: (path: string) => Promise<string>
}

const HELP_LINES = [
  'commands:',
  '  /interrupt      stop the reply in flight',
  '  /replay <file>  print a saved session log',
  '  /quit           close the session and exit',
  '  /help           show this help',
  '',
  'any other line is sent to the persona',
]

export async function runCli(options: RunCliOptions): Promise<void> {
  const { input, io, driver, provider } = options
  const readFileImpl = options.readFile ?? ((path: string) => readFile(path, 'utf8'))

  io.out(`provider: ${provider.kind} (${provider.label})`)
  io.out(`session: ${driver.sessionId}`)
  if (options.logPath !== undefined) io.out(`log: ${options.logPath}`)
  io.out('type /help for commands')

  let lineOpen = false
  let logFailed = false

  const startPersona = (): void => {
    if (lineOpen) return
    io.write('persona> ')
    lineOpen = true
  }

  const render = (event: SessionEvent): void => {
    switch (event.type) {
      case 'user.utterance.committed':
        io.out(`you> ${event.payload.text}`)
        break
      case 'persona.response.started':
        break
      case 'persona.response.chunk':
        startPersona()
        io.write(event.payload.text)
        break
      case 'persona.response.committed':
        if (event.payload.text.length === 0) {
          io.out('persona> [empty response]')
          lineOpen = false
          break
        }
        io.write('\n')
        lineOpen = false
        break
      case 'persona.response.cancelled': {
        if (lineOpen) io.write('\n')
        lineOpen = false
        io.out(cancelledLabel(event))
        break
      }
      case 'session.completed':
        if (lineOpen) {
          io.write('\n')
          lineOpen = false
        }
        break
      default:
        break
    }
  }

  const consumer = (async () => {
    for await (const event of driver.events) {
      if (options.log !== undefined) {
        try {
          await options.log.append(event)
        } catch (error) {
          if (!logFailed) {
            logFailed = true
            io.err(`log write failed: ${messageOf(error)}`)
          }
        }
      }
      render(event)
    }
  })()

  const pending = new Set<Promise<void>>()
  let closed = false

  for await (const raw of input) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue

    if (line === '/quit') {
      await driver.close()
      closed = true
      break
    }

    if (line === '/help') {
      for (const helpLine of HELP_LINES) io.out(helpLine)
      continue
    }

    if (line === '/interrupt') {
      await driver.interrupt()
      continue
    }

    if (line === '/replay' || line.startsWith('/replay ')) {
      const path = line.slice('/replay'.length).trim()
      if (path === '') {
        io.err('usage: /replay <file>')
        continue
      }
      await driver.interrupt()
      try {
        await printReplay(path, io, readFileImpl)
      } catch (error) {
        io.err(`replay failed: ${messageOf(error)}`)
      }
      continue
    }

    const sending = driver.send(line).catch((error: unknown) => {
      io.err(`send failed: ${messageOf(error)}`)
    })
    pending.add(sending)
    void sending.finally(() => pending.delete(sending))
  }

  await Promise.all([...pending])
  if (!closed) await driver.close()
  await consumer
}

function cancelledLabel(event: SessionEventOf<'persona.response.cancelled'>): string {
  switch (event.payload.reason) {
    case 'provider_failure':
      return '[cancelled: provider failure]'
    case 'interrupted':
      return '[cancelled: interrupted]'
    case 'timeout':
      return '[cancelled: timeout]'
    case 'user_barge_in':
      return '[cancelled: user barge-in]'
    case 'revoked':
      return '[cancelled: grant revoked]'
  }
}

async function printReplay(
  path: string,
  io: CliIo,
  readFileImpl: (path: string) => Promise<string>,
): Promise<void> {
  const replayed = replaySessionLog(await readFileImpl(path))

  io.out(
    `session ${replayed.header.sessionId} (${replayed.header.startedAt}, provider ${replayed.header.provider}, lang ${replayed.header.lang})`,
  )

  for (const event of replayed.events) {
    switch (event.type) {
      case 'user.utterance.committed':
        io.out(`you> ${event.payload.text}`)
        break
      case 'persona.response.committed':
        io.out(`persona> ${event.payload.text}`)
        break
      case 'persona.response.cancelled': {
        const partial = event.payload.partialText ?? ''
        io.out(
          `persona> ${partial}${partial === '' ? '' : ' '}[cancelled: ${event.payload.reason}]`,
        )
        break
      }
      case 'session.completed':
        io.out('session completed')
        break
      default:
        break
    }
  }

  if (replayed.truncated) {
    io.out(`[truncated: replay stopped after ${replayed.records.length} complete record(s)]`)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
