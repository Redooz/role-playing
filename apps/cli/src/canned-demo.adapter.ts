import type { TextModelChunk, TextModelPort } from '@rp/session-core'

/**
 * Offline demo model for the CLI's `canned` mode.
 *
 * It is not a substitute for the eval harness's recorded replay and it never
 * pretends to be a persona: the fixed reply says what it is. The mode exists so
 * the CLI, the log and the replay path can be exercised without a provider.
 */

export const CANNED_DEMO_LABEL = 'canned/demo'

const DEFAULT_REPLY =
  'This is canned demo output. Add GROQ_API_KEY to .env and run with --provider live for a real reply.'

export function createCannedDemoModel(reply = DEFAULT_REPLY): TextModelPort {
  return {
    kind: 'canned',
    label: CANNED_DEMO_LABEL,
    complete(): AsyncIterable<TextModelChunk> {
      return chunksOf(reply)
    },
  }
}

async function* chunksOf(text: string): AsyncIterable<TextModelChunk> {
  const tokens = text.match(/\S+\s*/g) ?? [text]
  for (const [index, token] of tokens.entries()) {
    yield { text: token, done: index === tokens.length - 1 }
  }
}
