import { createHmac } from 'node:crypto'
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
 * LiveKit Inference text adapter — probe/comparison use.
 *
 * LiveKit Inference exposes an OpenAI-compatible chat-completions gateway.
 * Authentication is a short-lived JWT signed with the project's LiveKit API key
 * and secret; there is no per-provider key. The token carries an `inference`
 * grant and is minted per request, so a long run never holds an expired token.
 *
 * This is **not** the product persona path: the fixed model stays Groq
 * `openai/gpt-oss-20b`. The adapter exists so `google/gemma-4-31b-it` can be
 * measured against the same session driver, and it is always labelled a probe.
 */

export const LIVEKIT_INFERENCE_DEFAULT_BASE_URL = 'https://agent-gateway.livekit.cloud/v1'
export const LIVEKIT_GEMMA_MODEL = 'google/gemma-4-31b-it'

/**
 * Generation profile for the Gemma probe.
 *
 * Gemma does not use a reasoning channel here: LiveKit turns reasoning on only
 * when `reasoning_effort` is a non-`none` value, and a spoken role-play turn
 * must not spend its token budget on hidden reasoning. The token cap leaves
 * room for a normal multi-sentence reply.
 */
export const LIVEKIT_GENERATION_PARAMETERS: OpenAiGenerationOptions = {
  temperature: 0.6,
  topP: 0.95,
  maxCompletionTokens: 1024,
}

/** Short-lived token; LiveKit's own SDK uses a ten-minute default. */
export const LIVEKIT_TOKEN_TTL_SECONDS = 600

export type LiveKitInferenceRequestTiming = TextRequestTiming

export interface LiveKitInferenceTextModelOptions {
  readonly apiKey: string
  readonly apiSecret: string
  /** LiveKit Inference model id, for example `google/gemma-4-31b-it`. */
  readonly model: string
  /** Override for tests, staging or a proxy. */
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
  readonly onTiming?: (timing: LiveKitInferenceRequestTiming) => void
  readonly now?: () => number
  /** Injected clock for the JWT `exp` claim; tests only. */
  readonly nowSeconds?: () => number
  readonly tokenTtlSeconds?: number
  /** Override the fixed generation profile (tests or a probe only). */
  readonly generation?: OpenAiGenerationOptions
}

export class LiveKitInferenceTextModelError extends Error {
  readonly status: number | undefined

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LiveKitInferenceTextModelError'
    this.status = options.status
  }
}

export function liveKitModelLabel(model: string): string {
  return `livekit/${model}`
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/**
 * Mint the access token LiveKit Inference expects.
 *
 * Shape mirrors `livekit-server-sdk`'s `AccessToken` with
 * `addInferenceGrant({ perform: true })`: HS256, issuer is the API key,
 * subject `agent`, `nbf: 0`, and an `inference.perform` grant.
 */
export function createLiveKitInferenceAccessToken(options: {
  readonly apiKey: string
  readonly apiSecret: string
  readonly ttlSeconds?: number
  readonly nowSeconds?: () => number
}): string {
  if (options.apiKey.trim() === '' || options.apiSecret.trim() === '') {
    throw new LiveKitInferenceTextModelError(
      'LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required; the adapter cannot start',
    )
  }

  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  const ttlSeconds = options.ttlSeconds ?? LIVEKIT_TOKEN_TTL_SECONDS
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' })
  const payload = base64UrlJson({
    inference: { perform: true },
    iss: options.apiKey,
    sub: 'agent',
    nbf: 0,
    exp: nowSeconds() + ttlSeconds,
  })
  const unsigned = `${header}.${payload}`
  const signature = createHmac('sha256', options.apiSecret).update(unsigned).digest('base64url')
  return `${unsigned}.${signature}`
}

export function createLiveKitInferenceTextModel(
  options: LiveKitInferenceTextModelOptions,
): TextModelPort {
  if (options.apiKey.trim() === '') {
    throw new LiveKitInferenceTextModelError('LIVEKIT_API_KEY is empty; the adapter cannot start')
  }
  if (options.apiSecret.trim() === '') {
    throw new LiveKitInferenceTextModelError(
      'LIVEKIT_API_SECRET is empty; the adapter cannot start',
    )
  }
  if (options.model.trim() === '') {
    throw new LiveKitInferenceTextModelError('a LiveKit Inference model id is required')
  }

  const baseUrl = options.baseUrl ?? LIVEKIT_INFERENCE_DEFAULT_BASE_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? defaultTimingClock()
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  const tokenTtlSeconds = options.tokenTtlSeconds ?? LIVEKIT_TOKEN_TTL_SECONDS
  const label = liveKitModelLabel(options.model)

  return {
    kind: 'live',
    label,
    complete(
      request: TextModelRequest,
      completeOptions?: TextModelCompleteOptions,
    ): AsyncIterable<TextModelChunk> {
      // A fresh token per request costs one HMAC; a stale token would fail the
      // whole trial after ten minutes.
      const accessToken = createLiveKitInferenceAccessToken({
        apiKey: options.apiKey,
        apiSecret: options.apiSecret,
        ttlSeconds: tokenTtlSeconds,
        nowSeconds,
      })

      return streamOpenAiCompatible({
        apiKey: accessToken,
        baseUrl,
        model: options.model,
        request,
        signal: completeOptions?.signal,
        fetchImpl,
        onTiming: options.onTiming,
        now,
        providerName: 'LiveKit Inference',
        generation: options.generation ?? LIVEKIT_GENERATION_PARAMETERS,
        createError: (message, errorOptions) =>
          new LiveKitInferenceTextModelError(message, errorOptions),
      })
    },
  }
}
