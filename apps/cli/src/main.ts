import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { createGroqTextModel } from '@rp/pipeline'
import {
  TRANSCRIPT_SCHEMA_VERSION,
  createTextSessionDriver,
  type SessionLanguage,
  type SessionLogHeader,
  type TextModelPort,
} from '@rp/session-core'
import { FakeClock, SystemClock, type Clock } from '@rp/shared'
import { createCannedDemoModel } from './canned-demo.adapter.js'
import { runCli, type CliIo, type CliProvider } from './cli-main.js'
import { createFileSessionLog, type SessionLog } from './session-log.adapter.js'

/**
 * Composition root for the text session CLI (M1 D4/D6).
 *
 * This is the only place that reads `GROQ_API_KEY`, chooses a provider and
 * opens files. The driver, the REPL and the log codec stay provider- and
 * transport-agnostic.
 */

const USAGE = `role-play - single-agent text session (M1)

Usage:
  npm run chat -- [options]

Options:
  --provider <canned|live>  canned is offline demo output; live calls Groq (default: canned)
  --lang <en|fr>            session language (default: en)
  --log-dir <dir>           where session logs are written (default: sessions)
  --session-id <id>         override the per-process session id (tests only)
  --task <id>               record a task id in the log header
  --help                    show this help

Live mode requires GROQ_API_KEY in the environment (npm loads .env). The key is
never printed. The model is fixed to openai/gpt-oss-20b.`

/**
 * A session id becomes a file name, so only path-safe characters are allowed.
 * The default `randomUUID()` passes; an override that does not is rejected with
 * exit code 2 before any file is touched.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function isValidSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value)
}

/**
 * Resolve the log file for a session id and reject any path that escapes the
 * log directory. The id validation already makes traversal impossible; this is
 * the defence-in-depth check on the resolved path.
 */
export function resolveSessionLogPath(logDir: string, sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`invalid session id "${sessionId}"`)
  }

  const base = resolve(logDir)
  const path = resolve(base, `${sessionId}.jsonl`)
  const relativePath = relative(base, path)
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`refusing to write a session log outside "${base}"`)
  }

  return path
}

export async function main(argv: readonly string[]): Promise<number> {
  const io: CliIo = {
    write: (text) => void process.stdout.write(text),
    out: (line) => void process.stdout.write(`${line}\n`),
    err: (line) => void process.stderr.write(`${line}\n`),
  }

  let values: {
    provider?: string
    lang?: string
    'log-dir'?: string
    'session-id'?: string
    task?: string
    help?: boolean
  }

  try {
    values = parseArgs({
      args: [...argv],
      options: {
        provider: { type: 'string', default: 'canned' },
        lang: { type: 'string', default: 'en' },
        'log-dir': { type: 'string', default: 'sessions' },
        'session-id': { type: 'string' },
        task: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    }).values
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`)
    io.err('run with --help for usage')
    return 2
  }

  if (values.help === true) {
    io.out(USAGE)
    return 0
  }

  const providerMode = values.provider ?? 'canned'
  if (providerMode !== 'canned' && providerMode !== 'live') {
    io.err(`error: --provider must be "canned" or "live", got "${providerMode}"`)
    return 2
  }

  const lang = values.lang ?? 'en'
  if (lang !== 'en' && lang !== 'fr') {
    io.err(`error: --lang must be "en" or "fr", got "${lang}"`)
    return 2
  }

  if (values.task !== undefined && values.task.trim() === '') {
    io.err('error: --task must not be empty')
    return 2
  }

  const sessionIdOverride = values['session-id']
  if (sessionIdOverride !== undefined && !isValidSessionId(sessionIdOverride)) {
    io.err(
      `error: --session-id must match ${SESSION_ID_PATTERN.source}, got "${sessionIdOverride}"`,
    )
    return 2
  }

  const sessionId = sessionIdOverride ?? randomUUID()
  const logDir = resolve(values['log-dir'] ?? 'sessions')

  let logPath: string
  try {
    logPath = resolveSessionLogPath(logDir, sessionId)
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }

  let provider: CliProvider
  let clock: Clock
  let clockMode: 'simulated' | 'wall'
  let model: TextModelPort

  if (providerMode === 'live') {
    const apiKey = process.env['GROQ_API_KEY']
    if (apiKey === undefined || apiKey.trim() === '') {
      io.err('error: live mode requires GROQ_API_KEY; add it to .env or use --provider canned')
      return 2
    }
    model = createGroqTextModel({ apiKey })
    provider = { kind: 'live', label: model.label }
    clock = new SystemClock()
    clockMode = 'wall'
  } else {
    model = createCannedDemoModel()
    provider = { kind: 'canned', label: model.label }
    clock = new FakeClock(0)
    clockMode = 'simulated'
  }

  const driver = createTextSessionDriver({
    sessionId,
    lang: lang as SessionLanguage,
    clockMode,
    clock,
    model,
    ...(values.task === undefined ? {} : { taskId: values.task }),
  })

  const header: SessionLogHeader = {
    type: 'session.header',
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    sessionId,
    startedAt: new Date().toISOString(),
    clockMode,
    lang: lang as SessionLanguage,
    provider: model.label,
    ...(values.task === undefined ? {} : { taskId: values.task }),
  }

  let log: SessionLog
  try {
    log = await createFileSessionLog({
      path: logPath,
      header,
      clock,
      wallClock: () => Date.now(),
    })
  } catch (error) {
    io.err(
      `error: could not create the session log: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 2
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  })

  try {
    await runCli({
      input: rl,
      io,
      driver,
      provider,
      log,
      logPath,
    })
    return 0
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    rl.close()
  }
}
