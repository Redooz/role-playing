import { SpeechTextFilter, createSeededRandom, hashValue, type Clock } from '@rp/shared'
import { buildSessionRoutingContext, personaById } from '@rp/persona-kit'
import {
  createDetPersonaLivePolicy,
  createFixedRotationLivePolicy,
  type RoutingContext,
} from '@rp/routing-policy'
import { scenarioById } from '@rp/scenario-kit'
import { INITIAL_ARBITER_STATE, parseTurnArbiterConfig, reduce } from '@rp/turn-arbiter'
import {
  createTextSessionDriver,
  type TextModelChunk,
  type TextModelPort,
  type TextModelRequest,
} from '@rp/session-core'
import type { TaskEntry } from '../tasks/schema.js'
import { SessionTaskError, type SessionPersonaPrompt } from './session-prompt.js'

/**
 * Session driver wiring (M2 D7, M3b).
 *
 * Builds the text driver a session task runs on — single-persona, or the
 * multi-persona arbiter driver — and wraps every persona model with the shared
 * plain-text filter. It holds no transcript or scoring state.
 */

export type SessionPolicyId = 'det-persona' | 'fixed-rotation'

/** Apply the shared plain-text filter between a model and the driver. */
export function withPlainText(inner: TextModelPort): TextModelPort {
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

/** Multi-persona driver wiring for the live runner. */
export function createMultiPersonaDriver(options: {
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
