import { HarnessConfigError, type CompletionProvider, type ProviderFactory } from '@rp/eval-harness'
import {
  GROQ_BASE_URL,
  LIVEKIT_INFERENCE_DEFAULT_BASE_URL,
  OPENROUTER_BASE_URL,
  createGroqTextModel,
  createLiveKitInferenceTextModel,
  createOpenRouterTextModel,
} from '@rp/pipeline'
import type { TextModelPort } from '@rp/session-core'

/**
 * Live provider selection for the eval CLI.
 *
 * The product model is fixed to Groq `openai/gpt-oss-20b`. Two probe paths can
 * run the same session driver while the Groq organization budget is exhausted:
 *
 * - `openrouter/openai/gpt-oss-safeguard-20b` routes to Groq through OpenRouter;
 * - `livekit/google/gemma-4-31b-it` uses LiveKit Inference's hosted Gemma.
 *
 * Both are **probes**: they are different model artifacts and cannot substitute
 * for the pinned-model gate. Base URLs come from the environment so a proxy or
 * gateway can be swapped without editing code; the defaults stay in the
 * adapters.
 *
 * Kept out of `cli-main.ts` so the provider wiring is testable and the CLI
 * mutation scope stays focused on parsing/rendering.
 */

export type LiveProviderKind = 'groq' | 'openrouter' | 'livekit'

export interface LiveProviderSelection {
  readonly kind: LiveProviderKind
  readonly modelId?: string
}

export interface LiveProviderCredentials {
  readonly apiKey: string
  readonly apiSecret?: string
  readonly baseUrl: string
}

export const GROQ_FIXED_MODEL = 'openai/gpt-oss-20b'

/** Resolve a manifest provider label to an adapter and model id. */
export function selectLiveProvider(label: string): LiveProviderSelection {
  if (label.startsWith('openrouter/')) {
    const modelId = label.slice('openrouter/'.length)
    if (modelId === '') {
      throw new HarnessConfigError('an openrouter/ live label must name a model id')
    }
    return { kind: 'openrouter', modelId }
  }

  if (label.startsWith('livekit/')) {
    const modelId = label.slice('livekit/'.length)
    if (modelId === '') {
      throw new HarnessConfigError('a livekit/ live label must name a model id')
    }
    return { kind: 'livekit', modelId }
  }

  if (label.startsWith('groq/')) {
    const modelId = label.slice('groq/'.length)
    if (modelId !== GROQ_FIXED_MODEL) {
      throw new HarnessConfigError(
        `the Groq persona model is fixed to ${GROQ_FIXED_MODEL}; refusing label "${label}"`,
      )
    }
    return { kind: 'groq', modelId }
  }

  throw new HarnessConfigError(
    `live provider label "${label}" must start with "groq/", "openrouter/" or "livekit/"`,
  )
}

export interface LiveProviderOptions {
  readonly label: string
  readonly env: NodeJS.ProcessEnv
  /** Minimum gap between calls. Zero means no pacing. */
  readonly paceMs: number
  /** Injected for tests; adapters use the global fetch by default. */
  readonly createModel?: (
    selection: LiveProviderSelection,
    credentials: LiveProviderCredentials,
  ) => TextModelPort
  /** Override the retry backoff (tests). */
  readonly retryBackoffMs?: readonly number[]
}

/** Build a fresh live provider per trial, pacing calls across the whole run. */
export function createLiveProviderFactory(options: LiveProviderOptions): ProviderFactory {
  const selection = selectLiveProvider(options.label)
  const credentials = resolveCredentials(selection.kind, options.env)

  let nextCallAt = 0

  return (): CompletionProvider => {
    const model = createModel(selection, credentials, options.createModel)
    return {
      kind: 'live',
      label: options.label,
      complete(request, completeOptions) {
        return pacedStream(model, request, completeOptions, {
          paceMs: options.paceMs,
          nextCallAt: () => nextCallAt,
          setNextCallAt: (value) => {
            nextCallAt = value
          },
          retryBackoffMs: options.retryBackoffMs ?? RETRY_BACKOFF_MS,
        })
      },
      dispose() {
        return model.dispose?.()
      },
    }
  }
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    throw new HarnessConfigError(`a live run requires ${name} (set it in .env or the environment)`)
  }
  return value
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

function resolveCredentials(
  kind: LiveProviderKind,
  env: NodeJS.ProcessEnv,
): LiveProviderCredentials {
  if (kind === 'groq') {
    return {
      apiKey: requireEnv(env, 'GROQ_API_KEY'),
      baseUrl: optionalEnv(env, 'GROQ_BASE_URL') ?? GROQ_BASE_URL,
    }
  }

  if (kind === 'openrouter') {
    return {
      apiKey: requireEnv(env, 'OPENROUTER_API_KEY'),
      baseUrl: optionalEnv(env, 'OPENROUTER_BASE_URL') ?? OPENROUTER_BASE_URL,
    }
  }

  return {
    apiKey: requireEnv(env, 'LIVEKIT_API_KEY'),
    apiSecret: requireEnv(env, 'LIVEKIT_API_SECRET'),
    baseUrl: optionalEnv(env, 'LIVEKIT_INFERENCE_URL') ?? LIVEKIT_INFERENCE_DEFAULT_BASE_URL,
  }
}

function createModel(
  selection: LiveProviderSelection,
  credentials: LiveProviderCredentials,
  factory: LiveProviderOptions['createModel'],
): TextModelPort {
  if (factory !== undefined) return factory(selection, credentials)
  if (selection.kind === 'groq') {
    return createGroqTextModel({ apiKey: credentials.apiKey, baseUrl: credentials.baseUrl })
  }
  if (selection.kind === 'livekit') {
    return createLiveKitInferenceTextModel({
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret ?? '',
      model: selection.modelId ?? '',
      baseUrl: credentials.baseUrl,
    })
  }
  return createOpenRouterTextModel({
    apiKey: credentials.apiKey,
    model: selection.modelId ?? '',
    baseUrl: credentials.baseUrl,
    appName: 'role-playing-eval',
  })
}

interface PaceState {
  readonly paceMs: number
  readonly nextCallAt: () => number
  readonly setNextCallAt: (value: number) => void
  readonly retryBackoffMs: readonly number[]
}

const RETRYABLE_STATUS = 429
const MAX_RETRIES = 4
const RETRY_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000] as const

/** A provider rate limit is operational, not a failed judgment. */
function isRetryable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: unknown }).status === RETRYABLE_STATUS
  )
}

/** Pace live calls and retry a rate-limited request before it reaches the driver. */
async function* pacedStream(
  model: TextModelPort,
  request: Parameters<CompletionProvider['complete']>[0],
  options: Parameters<CompletionProvider['complete']>[1],
  pace: PaceState,
): AsyncIterable<{ readonly text: string; readonly done: boolean }> {
  for (let attempt = 0; ; attempt += 1) {
    const waitMs = Math.max(0, pace.nextCallAt() - Date.now())
    if (waitMs > 0) await delay(waitMs, options?.signal)
    pace.setNextCallAt(Date.now() + pace.paceMs)

    let yieldedAny = false
    try {
      for await (const chunk of model.complete(
        {
          messages: request.messages,
          ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        },
        options,
      )) {
        yieldedAny = true
        yield chunk
      }
      return
    } catch (error) {
      // Retry only a request that failed before producing text. A mid-stream
      // failure must not replay a prefix and duplicate the reply.
      if (yieldedAny || !isRetryable(error) || attempt >= MAX_RETRIES) throw error
      const backoff = pace.retryBackoffMs[attempt] ?? pace.retryBackoffMs.at(-1) ?? 10_000
      await delay(backoff, options?.signal)
    }
  }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('paced request was aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('paced request was aborted'))
      },
      { once: true },
    )
  })
}
