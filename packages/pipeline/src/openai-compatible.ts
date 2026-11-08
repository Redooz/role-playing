import { performance } from 'node:perf_hooks'
import type { TextModelChunk, TextModelRequest, TextModelUsage } from '@rp/session-core'

/**
 * Shared OpenAI-compatible chat-completions streaming (M1 D6).
 *
 * Groq and OpenRouter both expose this wire shape. The adapter-specific files
 * supply the base URL, model, headers and error type; the SSE parsing, usage
 * extraction and timing boundary live here once.
 *
 * The caller must keep the API key out of every label and error message.
 */

export interface TextRequestTiming {
  /** Present when the request carries a `requestId` in its metadata. */
  readonly requestId?: string
  readonly requestStartedAt: number
  readonly responseHeadersAt?: number
  readonly firstContentAt?: number
  readonly finishedAt: number
  readonly ok: boolean
  readonly status?: number
}

export interface CreateProviderErrorOptions {
  readonly status?: number
  readonly cause?: unknown
}

export type CreateProviderError = (message: string, options?: CreateProviderErrorOptions) => Error

export interface OpenAiCompatibleStreamOptions {
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
  readonly request: TextModelRequest
  readonly signal: AbortSignal | undefined
  readonly fetchImpl: typeof fetch
  readonly onTiming: ((timing: TextRequestTiming) => void) | undefined
  readonly now: () => number
  /** Provider name used in error messages, for example `Groq`. */
  readonly providerName: string
  /** Extra request headers, merged after the standard ones. */
  readonly headers?: Readonly<Record<string, string>>
  readonly createError: CreateProviderError
}

interface ProviderUsage {
  readonly prompt_tokens?: number
  readonly completion_tokens?: number
  readonly cost?: number
}

interface StreamChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: { readonly content?: string }
    readonly finish_reason?: string | null
  }>
  readonly usage?: ProviderUsage
  readonly x_groq?: { readonly usage?: ProviderUsage }
}

export function defaultTimingClock(): () => number {
  return () => performance.now()
}

export async function* streamOpenAiCompatible(
  options: OpenAiCompatibleStreamOptions,
): AsyncIterable<TextModelChunk> {
  const { apiKey, baseUrl, model, request, signal, fetchImpl, onTiming, now, providerName } =
    options
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const requestId = request.requestId
  const requestStartedAt = now()
  let responseHeadersAt: number | undefined
  let firstContentAt: number | undefined
  let status: number | undefined
  let ok = false

  try {
    let response: Response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...options.headers,
        },
        body: JSON.stringify({
          model,
          messages: request.messages,
          stream: true,
        }),
        signal,
      })
    } catch (error) {
      if (signal?.aborted === true) throw error
      throw options.createError(`${providerName} request failed before a response was received`, {
        cause: error,
      })
    }

    responseHeadersAt = now()
    status = response.status

    if (!response.ok) {
      throw options.createError(`${providerName} request failed with HTTP ${response.status}`, {
        status: response.status,
      })
    }
    if (response.body === null) {
      throw options.createError(`${providerName} returned no response body`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sawDone = false
    let sawFinishReason = false
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

          const chunk = parseChunk(data, options.createError)
          usage = readUsage(chunk) ?? usage
          const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
          // A non-null finish_reason is also a valid end; some compatible
          // servers omit the [DONE] sentinel.
          if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
            sawFinishReason = true
          }
          const text: unknown = choice?.delta?.content
          // A role-only delta may carry `content: null`; the wire is unvalidated
          // JSON, so check the type before treating it as text.
          if (typeof text === 'string' && text.length > 0) {
            firstContentAt ??= now()
            yield { text, done: false }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }

    if (!sawDone && !sawFinishReason) {
      throw options.createError(
        `${providerName} stream ended without a [DONE] marker or finish_reason`,
      )
    }

    ok = true
    yield { text: '', done: true, ...(usage === undefined ? {} : { usage }) }
  } finally {
    onTiming?.({
      ...(requestId === undefined ? {} : { requestId }),
      requestStartedAt,
      ...(responseHeadersAt === undefined ? {} : { responseHeadersAt }),
      ...(firstContentAt === undefined ? {} : { firstContentAt }),
      finishedAt: now(),
      ok,
      ...(status === undefined ? {} : { status }),
    })
  }
}

function parseChunk(data: string, createError: CreateProviderError): StreamChunk {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch (error) {
    throw createError('stream contained a malformed data line', { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw createError('stream contained a non-object data line')
  }
  return parsed as StreamChunk
}

function readUsage(chunk: StreamChunk): TextModelUsage | undefined {
  const raw = chunk.x_groq?.usage ?? chunk.usage
  if (typeof raw !== 'object' || raw === null) return undefined

  const usage: TextModelUsage = {
    ...(typeof raw.prompt_tokens === 'number' ? { inputTokens: raw.prompt_tokens } : {}),
    ...(typeof raw.completion_tokens === 'number' ? { outputTokens: raw.completion_tokens } : {}),
    ...(typeof raw.cost === 'number' ? { costUsd: raw.cost } : {}),
  }

  return Object.keys(usage).length === 0 ? undefined : usage
}
