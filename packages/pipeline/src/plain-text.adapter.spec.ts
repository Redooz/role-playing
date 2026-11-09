import { describe, expect, it } from 'vitest'
import type { TextModelChunk, TextModelPort, TextModelRequest } from '@rp/session-core'
import { createPersonaTextModel, createPlainTextModel } from './plain-text.adapter.js'

function scripted(
  chunks: readonly string[],
  options: { endWithoutDone?: boolean } = {},
): TextModelPort {
  return {
    kind: 'canned',
    label: 'scripted',
    async *complete(): AsyncIterable<TextModelChunk> {
      for (const [index, text] of chunks.entries()) {
        const last = index === chunks.length - 1
        yield { text, done: last && options.endWithoutDone !== true }
      }
    },
  }
}

const REQUEST: TextModelRequest = { messages: [{ role: 'user', content: 'hi' }] }

async function collect(model: TextModelPort): Promise<string> {
  let text = ''
  for await (const chunk of model.complete(REQUEST)) {
    if (chunk.done) expect(chunk.text).toBe('')
    else text += chunk.text
  }
  return text
}

describe('plain-text streaming decorator', () => {
  it('cleans Markdown and emoji before the driver sees them', async () => {
    const model = createPlainTextModel(scripted(['**Hello** ', '😀 there'], {}))
    expect(await collect(model)).toBe('Hello there')
  })

  it('preserves the final chunk and usage', async () => {
    const model = createPlainTextModel({
      kind: 'live',
      label: 'provider',
      async *complete(): AsyncIterable<TextModelChunk> {
        yield { text: 'ok', done: false }
        yield { text: '', done: true, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    })
    const chunks: TextModelChunk[] = []
    for await (const chunk of model.complete(REQUEST)) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({
      text: '',
      done: true,
      usage: { inputTokens: 1, outputTokens: 1 },
    })
  })

  it('is chunk-boundary independent', async () => {
    const text = '**One** sentence 😀. Another *sentence*!'
    const expected = await collect(createPlainTextModel(scripted([text])))
    for (let split = 0; split <= text.length; split += 1) {
      const model = createPlainTextModel(scripted([text.slice(0, split), text.slice(split)]))
      expect(await collect(model)).toBe(expected)
    }
  })

  it('reports stats and the empty-after-filter case', async () => {
    const seen: Array<{ emojiCount: number; markdownCount: number; emptyAfterFilter: boolean }> = []
    const model = createPersonaTextModel(scripted(['😀🎉']), {
      onStats: (stats) => seen.push(stats),
    })
    expect(await collect(model)).toBe('')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.emptyAfterFilter).toBe(true)
  })

  it('does not fabricate a final chunk when the provider omits one', async () => {
    const model = createPlainTextModel(scripted(['partial'], { endWithoutDone: true }))
    const chunks: TextModelChunk[] = []
    for await (const chunk of model.complete(REQUEST)) chunks.push(chunk)
    expect(chunks.every((chunk) => !chunk.done)).toBe(true)
  })

  it('delegates dispose', async () => {
    let disposed = false
    const model = createPlainTextModel({
      kind: 'live',
      label: 'provider',
      async *complete(): AsyncIterable<TextModelChunk> {
        yield { text: 'ok', done: true }
      },
      dispose() {
        disposed = true
      },
    })
    await collect(model)
    await model.dispose?.()
    expect(disposed).toBe(true)
  })
})
