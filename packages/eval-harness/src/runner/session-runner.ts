import {
  MemoryTranscriptSink,
  SpeechTextFilter,
  canonicalizeLocale,
  createSeededRandom,
  hashValue,
  type Clock,
} from '@rp/shared'
import {
  buildPersonaPrompt,
  buildSessionRoutingContext,
  personaById,
  PROMPT_TEMPLATE_VERSION,
  promptVersionForStyle,
  type BuiltPersonaPrompt,
  type PromptStyle,
} from '@rp/persona-kit'
import {
  createDetPersonaLivePolicy,
  createFixedRotationLivePolicy,
  type RoutingContext,
} from '@rp/routing-policy'
import { scenarioById } from '@rp/scenario-kit'
import { INITIAL_ARBITER_STATE, parseTurnArbiterConfig, reduce } from '@rp/turn-arbiter'
import {
  TRANSCRIPT_SCHEMA_VERSION,
  createTextSessionDriver,
  expectedContentClass,
  normalizedTranscriptJsonl,
  type EventPayloadFor,
  type SessionEventName,
  type TextModelChunk,
  type TextModelPort,
  type TextModelRequest,
  type TranscriptRecord,
} from '@rp/session-core'
import type { TaskEntry } from '../tasks/schema.js'
import type { JevRoutingJudge } from '../jev/routing.js'
import type { CannedEntry, CompletionProvider } from './canned-provider.js'
import { ProviderUnavailableError } from './canned-provider.js'
import { runDeterministicRoutingReplay } from './routing.js'
import {
  runShadowArms,
  summarizeShadowRecords,
  type ShadowRecord,
  type ShadowSummary,
} from './shadow.js'
import { createCompletionProviderTextModel } from './text-model.adapter.js'
import { chunkText } from './replay.js'

/**
 * Live session runner (M2 D7).
 *
 * Drives the real `SessionDriver` with the persona prompt and a deterministic
 * scripted learner, then captures the emitted events as a transcript. It does
 * not import a provider SDK: the provider arrives through the trial's
 * `CompletionProvider`, which the composition root (CLI) or the canned bundle
 * supplies.
 *
 * The plain-text policy is applied here as a `TextModelPort` decorator using
 * the pure filter from `@rp/shared`, so the harness does not depend on
 * `@rp/pipeline`.
 */

export const SESSION_PERSONA_PROVIDER = 'persona'
export const SESSION_PERSONA_MODEL = 'canned/persona-v1'

/** A response was empty after filtering: a policy violation, not an outage. */
export class PlainTextPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlainTextPolicyError'
  }
}

/** A session task is missing its prompt date, persona, scenario or script. */
export class SessionTaskError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionTaskError'
  }
}

export interface SessionPromptContext {
  readonly prompt: BuiltPersonaPrompt
  readonly locale: string
}

export interface SessionPersonaPrompt extends SessionPromptContext {
  readonly personaId: string
}

export type SessionPromptMode = 'persona' | 'generic'
export type SessionPolicyId = 'det-persona' | 'fixed-rotation'

function resolvePersonaPrompt(
  task: TaskEntry,
  personaId: string,
  currentDate: string,
  mode: SessionPromptMode,
  style: PromptStyle,
): SessionPromptContext {
  const session = task.session
  if (task.mode !== 'session' || session === undefined) {
    throw new SessionTaskError(`task ${task.id} is not a session task`)
  }

  const locale = canonicalizeLocale(task.locale ?? task.lang)
  if (mode === 'generic') {
    return { prompt: buildGenericPrompt(task.lang, locale, currentDate), locale }
  }

  const persona = personaById(personaId)
  const scenario = scenarioById(session.scenarioId)
  if (persona.version !== session.personaVersion) {
    throw new SessionTaskError(
      `persona ${persona.id} is version ${persona.version}, not ${session.personaVersion}`,
    )
  }
  if (scenario.version !== session.scenarioVersion) {
    throw new SessionTaskError(
      `scenario ${scenario.id} is version ${scenario.version}, not ${session.scenarioVersion}`,
    )
  }

  const prompt = buildPersonaPrompt({ persona, scenario, locale, currentDate, style })
  return { prompt, locale }
}

/** Resolve persona, scenario, locale and render the versioned prompt. */
export function resolveSessionPrompt(
  task: TaskEntry,
  currentDate: string,
  mode: SessionPromptMode = 'persona',
  style: PromptStyle = 'harmony',
): SessionPromptContext {
  const session = task.session
  if (task.mode !== 'session' || session === undefined) {
    throw new SessionTaskError(`task ${task.id} is not a session task`)
  }
  return resolvePersonaPrompt(task, session.personaId, currentDate, mode, style)
}

/**
 * Resolve one prompt per eligible persona in driver order.
 *
 * A single-persona task keeps the M2 path. A multi-persona task requires the
 * persona prompt mode: the generic baseline has one identity and cannot speak as
 * two characters.
 */
export function resolveSessionPrompts(
  task: TaskEntry,
  currentDate: string,
  mode: SessionPromptMode = 'persona',
  style: PromptStyle = 'harmony',
): SessionPersonaPrompt[] {
  const session = task.session
  if (task.mode !== 'session' || session === undefined) {
    throw new SessionTaskError(`task ${task.id} is not a session task`)
  }

  const personaIds = session.personaIds ?? [session.personaId]
  if (personaIds.length > 1 && mode === 'generic') {
    throw new SessionTaskError(
      `task ${task.id} has ${personaIds.length} personas; the generic baseline supports one`,
    )
  }

  return personaIds.map((personaId) => ({
    personaId,
    ...resolvePersonaPrompt(task, personaId, currentDate, mode, style),
  }))
}

/**
 * M1-style generic baseline prompt. It has no persona identity, scenario facts
 * or two-bucket split, so the capability run compares the candidate against the
 * behaviour M1 actually had.
 */
export const GENERIC_PROMPT_TEMPLATE_VERSION = 'm2-generic-baseline-v1'

function buildGenericPrompt(
  lang: 'en' | 'fr',
  locale: string,
  currentDate: string,
): BuiltPersonaPrompt {
  const instruction = [
    '# Instructions',
    'You are a helpful assistant in a workplace role-play.',
    `Reply in ${lang === 'fr' ? 'French' : 'English'} (locale ${locale}).`,
    'Speak in plain text only, with no Markdown or emoji.',
    'Keep each reply short and ask at most one question.',
  ].join('\n')

  const promptVersion = GENERIC_PROMPT_TEMPLATE_VERSION
  const promptHash = hashValue({ mode: 'generic', lang, locale, currentDate, instruction })
  return {
    promptVersion,
    promptHash,
    locale,
    style: 'harmony',
    greetingPack: instruction,
    sessionPack: instruction,
    greetingSystemPrompt: instruction,
    sessionSystemPrompt: instruction,
    systemMessages: {
      greeting: [{ role: 'system', content: instruction }],
      session: [{ role: 'system', content: instruction }],
    },
  }
}

export interface SessionShadowOptions {
  readonly judge: JevRoutingJudge
  readonly seed: number
  readonly deadlineMs?: number
}

export interface RunSessionTaskOptions {
  readonly runId: string
  readonly executionId: string
  readonly task: TaskEntry
  readonly clock: Clock
  readonly provider: CompletionProvider
  readonly wallNow: () => number
  /** Pinned `YYYY-MM-DD`; never read from the clock. */
  readonly currentDate: string
  /** `persona` (candidate) or `generic` (M1-style baseline). */
  readonly promptMode?: SessionPromptMode
  /** Prompt family; defaults to the pinned Groq Harmony style. */
  readonly promptStyle?: PromptStyle
  /** Live control arm or the fixed-rotation baseline. Defaults to det-persona. */
  readonly policy?: SessionPolicyId
  /** Eval-only shadow arms; never changes a session event. */
  readonly shadow?: SessionShadowOptions
  readonly signal?: AbortSignal
}

export interface SessionPersonaPromptHash {
  readonly personaId: string
  readonly promptVersion: string
  readonly promptHash: string
}

export interface SessionRunResult {
  readonly records: readonly TranscriptRecord[]
  readonly jsonl: string
  readonly promptVersion: string
  readonly promptHash: string
  /** One entry per persona; a single-persona task has exactly one. */
  readonly personaPrompts: readonly SessionPersonaPromptHash[]
  /** Eval-only shadow records; absent when shadow is disabled. */
  readonly shadow?: {
    readonly records: readonly ShadowRecord[]
    readonly summary: ShadowSummary
  }
}

/** Multi-persona driver wiring for the live runner. */
function createMultiPersonaDriver(options: {
  readonly task: TaskEntry
  readonly prompts: readonly SessionPersonaPrompt[]
  readonly models: readonly TextModelPort[]
  readonly clock: Clock
  readonly locale: string
  readonly policy?: SessionPolicyId
  readonly onContext?: (context: RoutingContext) => void
}): ReturnType<typeof createTextSessionDriver> {
  const session = options.task.session
  if (session === undefined) throw new SessionTaskError(`task ${options.task.id} has no session`)
  const config = parseTurnArbiterConfig()
  const scenario = scenarioById(session.scenarioId)
  const personas = options.prompts.map((entry, index) => ({
    personaId: entry.personaId,
    model: options.models[index]!,
    instructions: entry.prompt.systemMessages.session,
    greetingInstructions: entry.prompt.systemMessages.greeting,
  }))
  const personasById = options.prompts.map((entry) => personaById(entry.personaId))
  const seed = Number.parseInt(hashValue({ taskId: options.task.id }).slice(0, 8), 16) >>> 0
  const random = createSeededRandom(seed)

  return createTextSessionDriver({
    sessionId: options.task.id,
    lang: options.task.lang,
    locale: options.locale,
    clockMode: 'simulated',
    clock: options.clock,
    personas,
    arbiter: {
      initialState: INITIAL_ARBITER_STATE,
      reduce: (state, input) => reduce(state, input, config),
    },
    policy:
      options.policy === 'fixed-rotation'
        ? createFixedRotationLivePolicy(personas.map((persona) => persona.personaId))
        : createDetPersonaLivePolicy(),
    buildContext: ({ turnId, messages }) => {
      const context = buildSessionRoutingContext({
        turnId,
        personas: personasById,
        scenario,
        locale: options.locale,
        messages: messages
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .map((message) => ({
            role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
            content: message.content,
            ...(message.personaId === undefined ? {} : { personaId: message.personaId }),
          })),
      })
      options.onContext?.(context)
      return context
    },
    seedSource: () => random.int(2_147_483_647),
    requestWindowMs: config.requestWindowMs,
  })
}

/** Execute one session task end to end and return its transcript. */
export async function runSessionTask(options: RunSessionTaskOptions): Promise<SessionRunResult> {
  const { runId, executionId, task, clock, provider, wallNow, currentDate, signal } = options
  const prompts = resolveSessionPrompts(
    task,
    currentDate,
    options.promptMode ?? 'persona',
    options.promptStyle ?? 'harmony',
  )
  const locale = prompts[0]!.locale
  if (
    (options.shadow !== undefined || options.policy === 'fixed-rotation') &&
    prompts.length === 1
  ) {
    throw new SessionTaskError(
      `task ${task.id} has one persona; a multi-persona policy or shadow requires two`,
    )
  }
  const contexts: RoutingContext[] = []

  const models = prompts.map((entry) =>
    withPlainText(
      createCompletionProviderTextModel({
        provider,
        providerName: SESSION_PERSONA_PROVIDER,
        model: SESSION_PERSONA_MODEL,
        metadata:
          prompts.length === 1
            ? { taskId: task.id }
            : { taskId: task.id, personaId: entry.personaId },
      }),
    ),
  )

  const driver =
    prompts.length === 1
      ? createTextSessionDriver({
          sessionId: task.id,
          lang: task.lang,
          locale,
          personaId: task.session?.personaId ?? undefined,
          clockMode: 'simulated',
          clock,
          model: models[0]!,
          instructions: prompts[0]!.prompt.systemMessages.session,
          greetingInstructions: prompts[0]!.prompt.systemMessages.greeting,
        })
      : createMultiPersonaDriver({
          task,
          prompts,
          models,
          clock,
          locale,
          policy: options.policy ?? 'det-persona',
          onContext: (context) => contexts.push(context),
        })

  const sink = new MemoryTranscriptSink<TranscriptRecord>()
  let seq = 0
  const append = <Name extends SessionEventName>(
    kind: Name,
    payload: EventPayloadFor<Name>,
  ): void => {
    sink.append({
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      runId,
      executionId,
      seq,
      tSim: clock.now(),
      tWall: wallNow(),
      kind,
      payload,
      contentClass: expectedContentClass(kind),
    })
    seq += 1
  }

  const consumer = (async () => {
    for await (const event of driver.events) append(event.type, event.payload)
  })()

  const shadowRecords: ShadowRecord[] = []
  try {
    throwIfAborted(signal)
    await driver.start()
    for (const turn of task.session?.scriptedUserTurns ?? []) {
      throwIfAborted(signal)
      await driver.send(turn)
      if (options.shadow !== undefined) {
        const context = contexts.at(-1)
        if (context === undefined) {
          throw new SessionTaskError(`task ${task.id} produced no routing context for shadow`)
        }
        const liveDecision = runDeterministicRoutingReplay(
          context,
          'persona_requests',
          options.shadow.seed,
        ).decision
        const shadowRun = await runShadowArms(
          {
            taskId: task.id,
            context,
            liveDecision,
            seed: options.shadow.seed,
            ...(options.shadow.deadlineMs === undefined
              ? {}
              : { deadlineMs: options.shadow.deadlineMs }),
          },
          options.shadow.judge,
        )
        shadowRecords.push(...shadowRun.records)
      }
    }
  } finally {
    await driver.close()
    await consumer
  }

  const records = [...sink.records]
  for (const record of records) {
    if (record.kind !== 'persona.response.cancelled') continue
    const payload = record.payload as { readonly reason?: unknown; readonly detail?: unknown }
    throw new ProviderUnavailableError(
      `session ${task.id} ended a turn with "${String(payload.reason)}"${
        typeof payload.detail === 'string' ? `: ${payload.detail}` : ''
      }; a failed model call is never a pass`,
      provider.label,
    )
  }

  for (const record of records) {
    if (record.kind !== 'persona.response.committed') continue
    const text = (record.payload as { readonly text?: unknown }).text
    if (typeof text !== 'string' || text.length === 0) {
      throw new PlainTextPolicyError(
        `session ${task.id} produced an empty reply after plain-text filtering`,
      )
    }
  }

  return {
    records,
    jsonl: normalizedTranscriptJsonl(records),
    promptVersion: prompts[0]!.prompt.promptVersion,
    promptHash:
      prompts.length === 1
        ? prompts[0]!.prompt.promptHash
        : hashValue(prompts.map((entry) => entry.prompt.promptHash)),
    personaPrompts: prompts.map((entry) => ({
      personaId: entry.personaId,
      promptVersion: entry.prompt.promptVersion,
      promptHash: entry.prompt.promptHash,
    })),
    ...(options.shadow === undefined
      ? {}
      : {
          shadow: {
            records: shadowRecords,
            summary: summarizeShadowRecords(task.id, task.lang, shadowRecords),
          },
        }),
  }
}

/**
 * Build canned regression entries for a session task.
 *
 * The requests mirror the driver exactly: greeting pack for the first turn,
 * full pack afterwards, then assistant/user history. A recording is keyed by
 * the full request hash, so a prompt or locale change invalidates it.
 */
export function buildSessionCannedEntries(
  task: TaskEntry,
  currentDate: string,
  style: PromptStyle = 'harmony',
  mode: SessionPromptMode = 'persona',
): CannedEntry[] {
  const session = task.session
  if (task.mode !== 'session' || session === undefined) return []
  if ((session.personaIds?.length ?? 1) > 1) {
    throw new SessionTaskError(
      `canned session replay does not support multi-persona task ${task.id}; use the live runner`,
    )
  }
  const replies = session.recordedPersonaTurns
  if (replies === undefined) {
    throw new SessionTaskError(
      `canned session replay for ${task.id} needs recordedPersonaTurns; refusing to fabricate persona output`,
    )
  }

  const expected = session.scriptedUserTurns.length + 1
  if (replies.length !== expected) {
    throw new SessionTaskError(
      `task ${task.id} has ${replies.length} recorded persona replies, expected ${expected}`,
    )
  }

  const { prompt, locale } = resolveSessionPrompt(task, currentDate, mode, style)
  const metadata = { lang: task.lang, locale, taskId: task.id }
  const entries: CannedEntry[] = []

  entries.push({
    request: completionRequest(
      [{ role: 'system', content: prompt.greetingSystemPrompt }],
      metadata,
    ),
    chunks: chunkText(replies[0] as string),
  })

  let history: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: prompt.sessionSystemPrompt },
  ]

  for (const [index, turn] of session.scriptedUserTurns.entries()) {
    history = [
      ...history,
      { role: 'assistant', content: replies[index] as string },
      { role: 'user', content: turn },
    ]
    entries.push({
      request: completionRequest(history, metadata),
      chunks: chunkText(replies[index + 1] as string),
    })
  }

  return entries
}

function completionRequest(
  messages: ReadonlyArray<{
    readonly role: 'system' | 'user' | 'assistant'
    readonly content: string
  }>,
  metadata: Readonly<Record<string, string>>,
): CannedEntry['request'] {
  return {
    provider: SESSION_PERSONA_PROVIDER,
    model: SESSION_PERSONA_MODEL,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    metadata,
  }
}

/** Apply the shared plain-text filter between a model and the driver. */
function withPlainText(inner: TextModelPort): TextModelPort {
  return {
    kind: inner.kind,
    label: inner.label,
    complete(
      request: TextModelRequest,
      options?: { readonly signal?: AbortSignal },
    ): AsyncIterable<TextModelChunk> {
      return filterChunks(inner.complete(request, options))
    },
    dispose() {
      return inner.dispose?.()
    },
  }
}

async function* filterChunks(chunks: AsyncIterable<TextModelChunk>): AsyncIterable<TextModelChunk> {
  const filter = new SpeechTextFilter()
  for await (const chunk of chunks) {
    if (chunk.text.length > 0) {
      const text = filter.push(chunk.text)
      if (text.length > 0) yield { text, done: false }
    }
    if (chunk.done) {
      const tail = filter.flush()
      if (tail.length > 0) yield { text: tail, done: false }
      yield {
        text: '',
        done: true,
        ...(chunk.usage === undefined ? {} : { usage: chunk.usage }),
      }
      return
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error('session run was aborted')
}

/** The template version a session manifest must agree with. */
export const SESSION_PROMPT_TEMPLATE_VERSION = PROMPT_TEMPLATE_VERSION

/** The template version for each prompt family. */
export const SESSION_PROMPT_TEMPLATE_VERSIONS: Readonly<Record<PromptStyle, string>> = {
  harmony: PROMPT_TEMPLATE_VERSION,
  gemma: promptVersionForStyle('gemma'),
}
