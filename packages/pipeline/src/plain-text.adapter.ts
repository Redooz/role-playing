import { SpeechTextFilter, type SpeechTextStats } from '@rp/shared'
import type {
  TextModelChunk,
  TextModelCompleteOptions,
  TextModelPort,
  TextModelRequest,
} from '@rp/session-core'

/**
 * Plain-text streaming decorator (M2 D3b).
 *
 * Sits between a provider and the session driver, so the driver, transcript and
 * history only ever see speech with no Markdown and no emoji. A prompt asks for
 * plain text; this hook enforces it.
 *
 * The decorator preserves the provider's chunk lifecycle: text is emitted as
 * `done: false`, and the provider's final chunk becomes one empty `done: true`
 * chunk with its usage. It never fabricates text, and a provider that ends
 * without a final chunk is not repaired here.
 */

export interface PlainTextModelOptions {
  /** Called once per completed response with the filter's counts. */
  readonly onStats?: (stats: SpeechTextStats) => void
}

type GenerationTextModel = TextModelPort & {
  readonly generation?: Readonly<Record<string, unknown>>
}

/** Wrap a model so every streamed chunk is filtered before the driver sees it. */
export function createPlainTextModel(
  inner: TextModelPort,
  options: PlainTextModelOptions = {},
): TextModelPort {
  return {
    kind: inner.kind,
    label: inner.label,
    complete(
      request: TextModelRequest,
      completeOptions?: TextModelCompleteOptions,
    ): AsyncIterable<TextModelChunk> {
      return filterStream(inner, request, completeOptions, options)
    },
    dispose() {
      return inner.dispose?.()
    },
  }
}

/** The product factory: one place applies the plain-text policy. */
export function createPersonaTextModel(
  inner: TextModelPort,
  options: PlainTextModelOptions = {},
): TextModelPort {
  return createPlainTextModel(inner, options)
}

async function* filterStream(
  inner: TextModelPort,
  request: TextModelRequest,
  completeOptions: TextModelCompleteOptions | undefined,
  options: PlainTextModelOptions,
): AsyncIterable<TextModelChunk> {
  const filter = new SpeechTextFilter()

  for await (const chunk of inner.complete(request, completeOptions)) {
    if (chunk.text.length > 0) {
      const text = filter.push(chunk.text)
      if (text.length > 0) yield { text, done: false }
    }

    if (chunk.done) {
      const tail = filter.flush()
      if (tail.length > 0) yield { text: tail, done: false }
      options.onStats?.(filter.stats())
      yield {
        text: '',
        done: true,
        ...(chunk.usage === undefined ? {} : { usage: chunk.usage }),
      }
      return
    }
  }

  // The provider ended without its final chunk. Mirror that failure boundary:
  // the driver will report a provider_failure rather than a committed reply.
  options.onStats?.(filter.stats())
}

/** Expose a static generation profile for a wrapped model, when it has one. */
export function personaModelGeneration(model: TextModelPort): Readonly<Record<string, unknown>> {
  return (model as GenerationTextModel).generation ?? {}
}
