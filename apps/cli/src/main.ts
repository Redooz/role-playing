import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import {
  LIVEKIT_GEMMA_MODEL,
  LIVEKIT_INFERENCE_DEFAULT_BASE_URL,
  createLiveKitInferenceTextModel,
  createPersonaTextModel,
} from '@rp/pipeline'
import {
  buildPersonaPrompt,
  buildSessionRoutingContext,
  personaById,
  personaVariant,
} from '@rp/persona-kit'
import { createDetPersonaLivePolicy } from '@rp/routing-policy'
import { scenarioById } from '@rp/scenario-kit'
import { INITIAL_ARBITER_STATE, parseTurnArbiterConfig, reduce } from '@rp/turn-arbiter'
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
  createSeededRandom,
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

const USAGE = `role-play - text session (M2/M3b)

Usage:
  npm run chat -- [options]

Options:
  --provider <canned|live>  canned is offline demo output; live calls LiveKit Gemma (default: canned)
  --lang <en|fr>            base session language (default: en)
  --locale <bcp47>          locale variant such as en-GB or fr-CA (default: the base lang)
  --persona <id>            manager, peer or client (canned default: manager)
  --personas <ids>          two comma-separated personas, e.g. manager,peer
  --scenario <id>           scenario id (canned default: request-deadline-extension)
  --log-dir <dir>           where session logs are written (default: sessions)
  --session-id <id>         override the per-process session id (tests only)
  --task <id>               record a task id in the log header
  --prompt-date <date>      pinned YYYY-MM-DD for the prompt (default: today)
  --help                    show this help

Live mode requires LIVEKIT_API_KEY and LIVEKIT_API_SECRET in the environment
(npm loads .env), and an explicit --persona or --personas plus --scenario. The
credentials are never printed. The model is fixed to google/gemma-4-31b-it.`

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
  return resolve(base, `${sessionId}.jsonl`)
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
    personas?: string
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
        provider: { type: 'string' },
        lang: { type: 'string' },
        locale: { type: 'string' },
        persona: { type: 'string' },
        personas: { type: 'string' },
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

  let personaIds: string[]
  if (values.personas !== undefined) {
    if (values.persona !== undefined) {
      io.err('error: use either --persona or --personas, not both')
      return 2
    }
    personaIds = values.personas
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '')
    if (personaIds.length !== 2) {
      io.err('error: --personas needs exactly two comma-separated persona ids')
      return 2
    }
    if (new Set(personaIds).size !== personaIds.length) {
      io.err('error: --personas must not repeat a persona id')
      return 2
    }
  } else {
    const personaId = values.persona ?? (providerMode === 'canned' ? 'manager' : undefined)
    if (personaId === undefined) {
      io.err('error: live mode requires --persona <manager|peer|client> or --personas <ids>')
      return 2
    }
    personaIds = [personaId]
  }

  const scenarioId =
    values.scenario ?? (providerMode === 'canned' ? 'request-deadline-extension' : undefined)
  if (scenarioId === undefined) {
    io.err('error: live mode requires --scenario <id>')
    return 2
  }

  let personaSpecs: ReturnType<typeof personaById>[]
  let scenario: ReturnType<typeof scenarioById>
  try {
    personaSpecs = personaIds.map((personaId) => personaById(personaId))
    scenario = scenarioById(scenarioId)
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const persona = personaSpecs[0]!

  const promptDate = values['prompt-date'] ?? new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(promptDate)) {
    io.err(`error: --prompt-date must be YYYY-MM-DD, got "${promptDate}"`)
    return 2
  }

  let prompts: ReturnType<typeof buildPersonaPrompt>[]
  try {
    prompts = personaSpecs.map((personaSpec) =>
      buildPersonaPrompt({
        persona: personaSpec,
        scenario,
        locale,
        currentDate: promptDate,
        style: 'gemma',
      }),
    )
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const prompt = prompts[0]!

  if (values.task !== undefined && values.task.trim() === '') {
    io.err('error: --task must not be empty')
    return 2
  }

  const sessionIdOverride = values['session-id']
  const sessionId = sessionIdOverride ?? randomUUID()
  if (!isValidSessionId(sessionId)) {
    io.err(
      `error: --session-id must match ${SESSION_ID_PATTERN.source}, got ${printable(sessionId)}`,
    )
    return 2
  }
  // parseArgs supplies the default, so the value is always present.
  const logDir = resolve(values['log-dir'] as string)

  const logPath = resolveSessionLogPath(logDir, sessionId)

  let provider: CliProvider
  let clock: Clock
  let clockMode: 'simulated' | 'wall'
  const models: TextModelPort[] = []

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
    for (const _persona of personaSpecs) {
      models.push(
        createPersonaTextModel(
          createLiveKitInferenceTextModel({
            apiKey,
            apiSecret,
            model: LIVEKIT_GEMMA_MODEL,
            baseUrl: nonEmptyEnv('LIVEKIT_INFERENCE_URL') ?? LIVEKIT_INFERENCE_DEFAULT_BASE_URL,
          }),
        ),
      )
    }
    provider = { kind: 'live', label: models[0]!.label }
    clock = new SystemClock()
    clockMode = 'wall'
  } else {
    for (const _persona of personaSpecs) {
      models.push(createPersonaTextModel(createCannedDemoModel()))
    }
    provider = { kind: 'canned', label: models[0]!.label }
    clock = new FakeClock(0)
    clockMode = 'simulated'
  }

  const taskOptions = values.task === undefined ? {} : { taskId: values.task }
  const multiPersona = personaSpecs.length > 1
  const arbiterConfig = parseTurnArbiterConfig()
  const random = createSeededRandom(0)

  const driver = multiPersona
    ? createTextSessionDriver({
        sessionId,
        lang: lang as SessionLanguage,
        locale,
        clockMode,
        clock,
        personas: personaSpecs.map((personaSpec, index) => ({
          personaId: personaSpec.id,
          model: models[index]!,
          instructions: prompts[index]!.systemMessages.session,
          greetingInstructions: prompts[index]!.systemMessages.greeting,
        })),
        arbiter: {
          initialState: INITIAL_ARBITER_STATE,
          reduce: (state, input) => reduce(state, input, arbiterConfig),
        },
        policy: createDetPersonaLivePolicy(),
        buildContext: ({ turnId, messages }) =>
          buildSessionRoutingContext({
            turnId,
            personas: personaSpecs,
            scenario,
            locale,
            messages: messages
              .filter((message) => message.role === 'user' || message.role === 'assistant')
              .map((message) => ({
                role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
                content: message.content,
                ...(message.personaId === undefined ? {} : { personaId: message.personaId }),
              })),
          }),
        seedSource: () => random.int(2_147_483_647),
        requestWindowMs: arbiterConfig.requestWindowMs,
        ...taskOptions,
      })
    : createTextSessionDriver({
        sessionId,
        lang: lang as SessionLanguage,
        locale,
        clockMode,
        clock,
        model: models[0]!,
        instructions: prompt.systemMessages.session,
        greetingInstructions: prompt.systemMessages.greeting,
        personaId: persona.id,
        ...taskOptions,
      })

  const header: SessionLogHeader = {
    type: 'session.header',
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    sessionId,
    startedAt: new Date().toISOString(),
    clockMode,
    lang: lang as SessionLanguage,
    provider: models[0]!.label,
    personaId: persona.id,
    ...(multiPersona ? { personaIds: personaSpecs.map((personaSpec) => personaSpec.id) } : {}),
    personaVersion: persona.version,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    locale,
    promptVersion: prompt.promptVersion,
    ...taskOptions,
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
    await disposeModels(models, io)
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
        ...(multiPersona
          ? {
              personas: personaSpecs.map((personaSpec) => ({
                personaId: personaSpec.id,
                personaName: personaVariant(personaSpec, locale).displayName,
              })),
            }
          : {}),
      },
    })
    return 0
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    rl.close()
    await disposeModels(models, io)
  }
}

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  if (!value) return undefined
  return value
}

/**
 * The composition root creates the models, so it releases them. A cleanup
 * failure is reported but never turns a finished session into a crash.
 */
async function disposeModels(models: readonly TextModelPort[], io: CliIo): Promise<void> {
  for (const model of models) {
    try {
      await model.dispose?.()
    } catch (error) {
      io.err(
        `error: could not release the model: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
