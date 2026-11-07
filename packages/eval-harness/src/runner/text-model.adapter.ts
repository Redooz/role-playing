import type {
  TextModelChunk,
  TextModelCompleteOptions,
  TextModelPort,
  TextModelRequest,
} from '@rp/session-core'
import type { CompletionMessage, CompletionProvider, CompletionRequest } from './canned-provider.js'

/**
 * Adapt the eval harness's `CompletionProvider` to the session driver's
 * `TextModelPort` (M1 D1).
 *
 * `session-core` owns the model port; the harness keeps its own provider shape
 * for recorded replay and adapts it here, so the driver never accepts two
 * request shapes and the canned provider keeps its payload-hash lookup.
 *
 * Metadata is merged with the request's own labels. The driver contributes
 * `lang`; a replay can contribute `taskId` and `turnIndex` so a recorded
 * response is found by the same hash it was stored under.
 */
export interface CompletionProviderTextModelOptions {
  readonly provider: CompletionProvider
  /** Provider label used in the completion request. Defaults to `persona`. */
  readonly providerName?: string
  /** Model label used in the completion request. Defaults to `canned/persona-v1`. */
  readonly model?: string
  /** Extra labels merged into every request; request metadata wins on a clash. */
  readonly metadata?: Readonly<Record<string, string>>
}

const DEFAULT_PROVIDER_NAME = 'persona'
const DEFAULT_MODEL = 'canned/persona-v1'

export function createCompletionProviderTextModel(
  options: CompletionProviderTextModelOptions,
): TextModelPort {
  const { provider } = options
  const providerName = options.providerName ?? DEFAULT_PROVIDER_NAME
  const model = options.model ?? DEFAULT_MODEL

  return {
    kind: provider.kind,
    label: provider.label,
    complete(
      request: TextModelRequest,
      completeOptions?: TextModelCompleteOptions,
    ): AsyncIterable<TextModelChunk> {
      const metadata = mergeMetadata(options.metadata, request.metadata)
      const completionRequest: CompletionRequest = {
        provider: providerName,
        model,
        messages: request.messages.map((message): CompletionMessage => ({
          role: message.role,
          content: message.content,
        })),
        ...(metadata === undefined ? {} : { metadata }),
      }

      return stopOnAbort(provider.complete(completionRequest), completeOptions)
    },
    dispose() {
      return provider.dispose?.()
    },
  }
}

function mergeMetadata(
  base: Readonly<Record<string, string>> | undefined,
  overlay: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (base === undefined && overlay === undefined) return undefined
  return { ...base, ...overlay }
}

/**
 * The legacy provider port has no abort signal, so the adapter enforces it at
 * the boundary: once the driver cancels, no further chunk reaches it.
 */
async function* stopOnAbort(
  chunks: AsyncIterable<{ readonly text: string; readonly done: boolean }>,
  options: TextModelCompleteOptions | undefined,
): AsyncIterable<TextModelChunk> {
  const signal = options?.signal

  for await (const chunk of chunks) {
    if (signal?.aborted === true) return
    yield chunk
  }
}
