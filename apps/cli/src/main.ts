import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import {
  LIVEKIT_GEMMA_MODEL,
  LIVEKIT_INFERENCE_DEFAULT_BASE_URL,
  createLiveKitInferenceTextModel,
  createPersonaTextModel,
} from '@rp/pipeline'
import { buildPersonaPrompt, personaById, personaVariant } from '@rp/persona-kit'
import { scenarioById } from '@rp/scenario-kit'
import {
  TRANSCRIPT_SCHEMA_VERSION,
  createTextSessionDriver,
  type SessionLanguage,
  type SessionLogHeader,
  type TextModelPort,
} from '@rp/session-core'
import {
  FakeClock,
  LocaleTagError,
  SystemClock,
  canonicalizeLocale,
  localeMatchesLanguage,
  type Clock,
} from '@rp/shared'
import { createCannedDemoModel } from './canned-demo.adapter.js'
import { runCli, type CliIo, type CliProvider } from './cli-main.js'
import { createFileSessionLog, type SessionLog } from './session-log.adapter.js'

/**
 * Composition root for the text session CLI (M1 D4/D6).
 *
 * This is the only place that reads the LiveKit credentials, chooses a provider
 * and opens files. The driver, the REPL and the log codec stay provider- and
 * transport-agnostic.
 */

const USAGE = `role-play - single-agent text session (M2)

Usage:
  npm run chat -- [options]

Options:
  --provider <canned|live>  canned is offline demo output; live calls LiveKit Gemma (default: canned)
  --lang <en|fr>            base session language (default: en)
  --locale <bcp47>          locale variant such as en-GB or fr-CA (default: the base lang)
  --persona <id>            manager, peer or client (canned default: manager)
  --scenario <id>           scenario id (canned default: request-deadline-extension)
  --log-dir <dir>           where session logs are written (default: sessions)
  --session-id <id>         override the per-process session id (tests only)
  --task <id>               record a task id in the log header
  --prompt-date <date>      pinned YYYY-MM-DD for the prompt (default: today)
  --help                    show this help

Live mode requires LIVEKIT_API_KEY and LIVEKIT_API_SECRET in the environment
(npm loads .env), and an explicit --persona and --scenario. The credentials are
never printed. The model is fixed to google/gemma-4-31b-it.`

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
 * Render an untrusted argument for an error message. It has already failed the
 * pattern, but it can still carry terminal escape sequences; escaping and
 * truncating keeps a rejected value from reaching the terminal raw.
 */
function printable(value: string): string {
  const bounded = value.length > 80 ? `${value.slice(0, 77)}...` : value
  return JSON.stringify(bounded)
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
    locale?: string
    persona?: string
    scenario?: string
    'log-dir'?: string
    'session-id'?: string
    task?: string
    'prompt-date'?: string
    help?: boolean
  }

  try {
    values = parseArgs({
      args: [...argv],
      options: {
        provider: { type: 'string', default: 'canned' },
        lang: { type: 'string', default: 'en' },
        locale: { type: 'string' },
        persona: { type: 'string' },
        scenario: { type: 'string' },
        'log-dir': { type: 'string', default: 'sessions' },
        'session-id': { type: 'string' },
        task: { type: 'string' },
        'prompt-date': { type: 'string' },
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

  let locale: string
  try {
    locale = canonicalizeLocale(values.locale ?? lang)
  } catch (error) {
    io.err(
      `error: ${error instanceof LocaleTagError ? error.message : error instanceof Error ? error.message : String(error)}`,
    )
    return 2
  }
  if (!localeMatchesLanguage(locale, lang)) {
    io.err(`error: --locale "${locale}" does not match --lang "${lang}"`)
    return 2
  }

  const personaId = values.persona ?? (providerMode === 'canned' ? 'manager' : undefined)
  if (personaId === undefined) {
    io.err('error: live mode requires --persona <manager|peer|client>')
    return 2
  }
  const scenarioId =
    values.scenario ?? (providerMode === 'canned' ? 'request-deadline-extension' : undefined)
  if (scenarioId === undefined) {
    io.err('error: live mode requires --scenario <id>')
    return 2
  }

  let persona: ReturnType<typeof personaById>
  let scenario: ReturnType<typeof scenarioById>
  try {
    persona = personaById(personaId)
    scenario = scenarioById(scenarioId)
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }

  const promptDate = values['prompt-date'] ?? new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(promptDate)) {
    io.err(`error: --prompt-date must be YYYY-MM-DD, got "${promptDate}"`)
    return 2
  }

  let prompt: ReturnType<typeof buildPersonaPrompt>
  try {
    prompt = buildPersonaPrompt({
      persona,
      scenario,
      locale,
      currentDate: promptDate,
      style: 'gemma',
    })
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }

  if (values.task !== undefined && values.task.trim() === '') {
    io.err('error: --task must not be empty')
    return 2
  }

  const sessionIdOverride = values['session-id']
  if (sessionIdOverride !== undefined && !isValidSessionId(sessionIdOverride)) {
    io.err(
      `error: --session-id must match ${SESSION_ID_PATTERN.source}, got ${printable(sessionIdOverride)}`,
    )
    return 2
  }

  const sessionId = sessionIdOverride ?? randomUUID()
  // parseArgs supplies the default, so the value is always present.
  const logDir = resolve(values['log-dir'] as string)

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
    const apiKey = process.env['LIVEKIT_API_KEY']
    const apiSecret = process.env['LIVEKIT_API_SECRET']
    if (
      apiKey === undefined ||
      apiKey.trim() === '' ||
      apiSecret === undefined ||
      apiSecret.trim() === ''
    ) {
      io.err(
        'error: live mode requires LIVEKIT_API_KEY and LIVEKIT_API_SECRET; add them to .env or use --provider canned',
      )
      return 2
    }
    model = createPersonaTextModel(
      createLiveKitInferenceTextModel({
        apiKey,
        apiSecret,
        model: LIVEKIT_GEMMA_MODEL,
        baseUrl: nonEmptyEnv('LIVEKIT_INFERENCE_URL') ?? LIVEKIT_INFERENCE_DEFAULT_BASE_URL,
      }),
    )
    provider = { kind: 'live', label: model.label }
    clock = new SystemClock()
    clockMode = 'wall'
  } else {
    model = createPersonaTextModel(createCannedDemoModel())
    provider = { kind: 'canned', label: model.label }
    clock = new FakeClock(0)
    clockMode = 'simulated'
  }

  const driver = createTextSessionDriver({
    sessionId,
    lang: lang as SessionLanguage,
    locale,
    clockMode,
    clock,
    model,
    instructions: prompt.systemMessages.session,
    greetingInstructions: prompt.systemMessages.greeting,
    personaId: persona.id,
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
    personaId: persona.id,
    personaVersion: persona.version,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    locale,
    promptVersion: prompt.promptVersion,
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
    await disposeModel(model, io)
    return 2
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  })

  try {
    await driver.start()
    await runCli({
      input: rl,
      io,
      driver,
      provider,
      log,
      logPath,
      selection: {
        personaId: persona.id,
        personaName: personaVariant(persona, locale).displayName,
        scenarioId: scenario.id,
        locale,
      },
    })
    return 0
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    rl.close()
    await disposeModel(model, io)
  }
}

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * The composition root creates the model, so it releases it. A cleanup failure
 * is reported but never turns a finished session into a crash.
 */
async function disposeModel(model: TextModelPort, io: CliIo): Promise<void> {
  try {
    await model.dispose?.()
  } catch (error) {
    io.err(
      `error: could not release the model: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
