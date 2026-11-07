import { performance } from 'node:perf_hooks'
import type {
  TextModelChunk,
  TextModelCompleteOptions,
  TextModelPort,
  TextModelRequest,
  TextModelUsage,
} from '@rp/session-core'

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
 * Wall-clock boundary of one provider call, for the latency bench (M1 D5).
 * Values come from the same `performance.now()` clock as the bench, so
 * `firstContentAt - requestStartedAt` is provider time and the difference from
 * the driver's observed TTFT is local overhead.
 */
export interface GroqRequestTiming {
  readonly requestStartedAt: number
  readonly responseHeadersAt?: number
  readonly firstContentAt?: number
  readonly finishedAt: number
  readonly ok: boolean
  readonly status?: number
}

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
}

export class GroqTextModelError extends Error {
  readonly status: number | undefined

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GroqTextModelError'
    this.status = options.status
  }
}

interface GroqUsage {
  readonly prompt_tokens?: number
  readonly completion_tokens?: number
  readonly cost?: number
}

interface GroqStreamChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: { readonly content?: string }
    readonly finish_reason?: string | null
  }>
  readonly usage?: GroqUsage
  readonly x_groq?: { readonly usage?: GroqUsage }
}

export function createGroqTextModel(options: GroqTextModelOptions): TextModelPort {
  if (options.apiKey.trim() === '') {
    throw new GroqTextModelError('GROQ_API_KEY is empty; the live provider cannot start')
  }

  const baseUrl = options.baseUrl ?? GROQ_BASE_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => performance.now())

  return {
    kind: 'live',
    label: GROQ_TEXT_MODEL_LABEL,
    complete(
      request: TextModelRequest,
      completeOptions?: TextModelCompleteOptions,
    ): AsyncIterable<TextModelChunk> {
      return streamCompletion({
        apiKey: options.apiKey,
        baseUrl,
        request,
        signal: completeOptions?.signal,
        fetchImpl,
        onTiming: options.onTiming,
        now,
      })
    },
  }
}

interface StreamCompletionOptions {
  readonly apiKey: string
  readonly baseUrl: string
  readonly request: TextModelRequest
  readonly signal: AbortSignal | undefined
  readonly fetchImpl: typeof fetch
  readonly onTiming: ((timing: GroqRequestTiming) => void) | undefined
  readonly now: () => number
}

async function* streamCompletion(options: StreamCompletionOptions): AsyncIterable<TextModelChunk> {
  const { apiKey, baseUrl, request, signal, fetchImpl, onTiming, now } = options
  const requestStartedAt = now()
  let responseHeadersAt: number | undefined
  let firstContentAt: number | undefined
  let status: number | undefined
  let ok = false

  try {
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: GROQ_PERSONA_MODEL,
          messages: request.messages,
          stream: true,
        }),
        signal,
      })
    } catch (error) {
      if (signal?.aborted === true) throw error
      throw new GroqTextModelError('Groq request failed before a response was received', {
        cause: error,
      })
    }

    responseHeadersAt = now()
    status = response.status

    if (!response.ok) {
      throw new GroqTextModelError(`Groq request failed with HTTP ${response.status}`, {
        status: response.status,
      })
    }
    if (response.body === null) {
      throw new GroqTextModelError('Groq returned no response body')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sawDone = false
    let usage: TextModelUsage | undefined

    try {
      while (!sawDone) {
        const read = await reader.read()
        if (signal?.aborted === true) return
        if (read.done) break
        buffer += decoder.decode(read.value, { stream: true })

        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')

          if (line === '' || !line.startsWith('data:')) continue
          const data = line.slice('data:'.length).trim()
          if (data === '[DONE]') {
            sawDone = true
            break
          }

          const chunk = parseChunk(data)
          usage = readUsage(chunk) ?? usage
          const text = chunk.choices?.[0]?.delta?.content
          if (text !== undefined && text.length > 0) {
            firstContentAt ??= now()
            yield { text, done: false }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }

    if (!sawDone) {
      throw new GroqTextModelError('Groq stream ended without a [DONE] marker')
    }

    ok = true
    yield { text: '', done: true, ...(usage === undefined ? {} : { usage }) }
  } finally {
    onTiming?.({
      requestStartedAt,
      ...(responseHeadersAt === undefined ? {} : { responseHeadersAt }),
      ...(firstContentAt === undefined ? {} : { firstContentAt }),
      finishedAt: now(),
      ok,
      ...(status === undefined ? {} : { status }),
    })
  }
}

function parseChunk(data: string): GroqStreamChunk {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch (error) {
    throw new GroqTextModelError('Groq stream contained a malformed data line', { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new GroqTextModelError('Groq stream contained a non-object data line')
  }
  return parsed as GroqStreamChunk
}

function readUsage(chunk: GroqStreamChunk): TextModelUsage | undefined {
  const raw = chunk.x_groq?.usage ?? chunk.usage
  if (raw === undefined) return undefined

  const usage: TextModelUsage = {
    ...(typeof raw.prompt_tokens === 'number' ? { inputTokens: raw.prompt_tokens } : {}),
    ...(typeof raw.completion_tokens === 'number' ? { outputTokens: raw.completion_tokens } : {}),
    ...(typeof raw.cost === 'number' ? { costUsd: raw.cost } : {}),
  }

  return Object.keys(usage).length === 0 ? undefined : usage
}
