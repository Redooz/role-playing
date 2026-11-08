import type {
  TextModelChunk,
  TextModelCompleteOptions,
  TextModelPort,
  TextModelRequest,
} from '@rp/session-core'
import {
  defaultTimingClock,
  streamOpenAiCompatible,
  type TextRequestTiming,
} from './openai-compatible.js'

/**
 * OpenRouter text adapter — probe/comparison use.
 *
 * OpenRouter exposes an OpenAI-compatible chat-completions endpoint. This
 * adapter exists so a model can be measured against the same session driver and
 * latency bench as the fixed Groq persona model. It is **not** the persona path:
 * the product model stays `openai/gpt-oss-20b` on Groq (M1 D6 and AGENTS.md).
 *
 * The API key arrives from the composition root and never appears in a label,
 * log line or error message.
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const OPENROUTER_PROBE_MODEL = 'google/gemma-4-31b-it'

export type OpenRouterRequestTiming = TextRequestTiming

export interface OpenRouterTextModelOptions {
  readonly apiKey: string
  /** OpenRouter model id, for example `google/gemma-4-31b-it`. */
  readonly model: string
  /** Override for tests or a proxy. */
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
  readonly onTiming?: (timing: OpenRouterRequestTiming) => void
  readonly now?: () => number
  /** Sent as `X-Title`; OpenRouter uses it for attribution. */
  readonly appName?: string
}

export class OpenRouterTextModelError extends Error {
  readonly status: number | undefined

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'OpenRouterTextModelError'
    this.status = options.status
  }
}

export function openRouterModelLabel(model: string): string {
  return `openrouter/${model}`
}

export function createOpenRouterTextModel(options: OpenRouterTextModelOptions): TextModelPort {
  if (options.apiKey.trim() === '') {
    throw new OpenRouterTextModelError('OPENROUTER_API_KEY is empty; the adapter cannot start')
  }
  if (options.model.trim() === '') {
    throw new OpenRouterTextModelError('an OpenRouter model id is required')
  }

  const baseUrl = options.baseUrl ?? OPENROUTER_BASE_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? defaultTimingClock()
  const label = openRouterModelLabel(options.model)

  return {
    kind: 'live',
    label,
    complete(
      request: TextModelRequest,
      completeOptions?: TextModelCompleteOptions,
    ): AsyncIterable<TextModelChunk> {
      return streamOpenAiCompatible({
        apiKey: options.apiKey,
        baseUrl,
        model: options.model,
        request,
        signal: completeOptions?.signal,
        fetchImpl,
        onTiming: options.onTiming,
        now,
        providerName: 'OpenRouter',
        headers: { 'X-Title': options.appName ?? 'role-playing' },
        createError: (message, errorOptions) => new OpenRouterTextModelError(message, errorOptions),
      })
    },
  }
}
