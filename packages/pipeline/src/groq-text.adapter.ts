import type {
  TextModelChunk,
  TextModelCompleteOptions,
  TextModelPort,
  TextModelRequest,
} from '@rp/session-core'
import {
  defaultTimingClock,
  streamOpenAiCompatible,
  type OpenAiGenerationOptions,
  type TextRequestTiming,
} from './openai-compatible.js'

/**
 * Groq text adapter (M1 D6).
 *
 * Groq exposes an OpenAI-compatible chat-completions endpoint. The persona
 * model is fixed to `openai/gpt-oss-20b` by the milestone plan; it is not a
 * flag, an option or an environment override. Responses stream as plain text:
 * no JSON mode, no response format.
 *
 * The API key arrives from the composition root and is only placed in the
 * `Authorization` header. It never appears in a label, a log line or an error
 * message.
 */

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'
export const GROQ_PERSONA_MODEL = 'openai/gpt-oss-20b'
export const GROQ_TEXT_MODEL_LABEL = `groq/${GROQ_PERSONA_MODEL}`

/**
 * Fixed persona generation profile from the M2 plan. The model, temperature,
 * top_p, token cap and reasoning effort are recorded with every run; changing
 * one is a prompt-contract change, not a runtime option.
 */
export const GROQ_GENERATION_PARAMETERS: OpenAiGenerationOptions = {
  temperature: 0.6,
  topP: 0.95,
  maxCompletionTokens: 512,
  reasoningEffort: 'low',
  includeReasoning: false,
}

export type GroqRequestTiming = TextRequestTiming

export interface GroqTextModelOptions {
  readonly apiKey: string
  /** Override for tests or a proxy. */
  readonly baseUrl?: string
  /** Injected fetch, so tests never open a socket. */
  readonly fetchImpl?: typeof fetch
  /** Called once per request when the stream ends, succeeds or fails. */
  readonly onTiming?: (timing: GroqRequestTiming) => void
  /** Injectable clock for the timing boundary; defaults to `performance.now`. */
  readonly now?: () => number
  /** Override the fixed persona generation profile (tests or a probe only). */
  readonly generation?: OpenAiGenerationOptions
}

export class GroqTextModelError extends Error {
  readonly status: number | undefined

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GroqTextModelError'
    this.status = options.status
  }
}

export function createGroqTextModel(options: GroqTextModelOptions): TextModelPort {
  if (options.apiKey.trim() === '') {
    throw new GroqTextModelError('GROQ_API_KEY is empty; the live provider cannot start')
  }

  const baseUrl = options.baseUrl ?? GROQ_BASE_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? defaultTimingClock()

  return {
    kind: 'live',
    label: GROQ_TEXT_MODEL_LABEL,
    complete(
      request: TextModelRequest,
      completeOptions?: TextModelCompleteOptions,
    ): AsyncIterable<TextModelChunk> {
      return streamOpenAiCompatible({
        apiKey: options.apiKey,
        baseUrl,
        model: GROQ_PERSONA_MODEL,
        request,
        signal: completeOptions?.signal,
        fetchImpl,
        onTiming: options.onTiming,
        now,
        providerName: 'Groq',
        generation: options.generation ?? GROQ_GENERATION_PARAMETERS,
        createError: (message, errorOptions) => new GroqTextModelError(message, errorOptions),
      })
    },
  }
}
