import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FakeClock } from '@rp/shared'
import { expectedContentClass, isSessionEventName, parseTranscriptRecord } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import { taskEntrySchema, type TaskEntry } from '../tasks/schema.js'
import { createCannedProvider, type CompletionProvider } from './canned-provider.js'
import { ReplayAbortedError } from './canned-provider.js'
import {
  REPLAY_GRANT_TTL_MS,
  REPLAY_PERSONA_MODEL,
  REPLAY_PERSONA_PROVIDER,
  ReplayError,
  buildCannedEntriesForTask,
  buildPersonaRequest,
  chunkText,
  replayTask,
  type ReplayOptions,
} from './replay.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')

const taskPaths = [
  'evals/tasks/synthetic-workplace/v1/en/en-b1-report-deadline-001.json',
  'evals/tasks/synthetic-workplace/v1/fr/fr-b1-rapport-delai-001.json',
] as const

function loadTask(relativePath: string): TaskEntry {
  const raw = JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8')) as unknown
  return taskEntrySchema.parse(raw)
}

function cannedProviderFor(task: TaskEntry) {
  return createCannedProvider(buildCannedEntriesForTask(task))
}

/** A copy of the first fixture with a replacement turn list. */
function withTurns(turns: TaskEntry['content']['turns']): TaskEntry {
  const clone = structuredClone(loadTask(taskPaths[0]))
  return taskEntrySchema.parse({ ...clone, content: { ...clone.content, turns } })
}

const fixedWallNow = (): number => 1_700_000_000_000
const EXECUTION_ID = 'replay-test-execution'

describe('deterministic replay harness', () => {
  it.each(taskPaths)('emits the required event sequence for %s', async (relativePath) => {
    const task = loadTask(relativePath)
    const result = await replayTask({
      runId: 'replay-test',
      executionId: EXECUTION_ID,
      task,
      clock: new FakeClock(0),
      provider: cannedProviderFor(task),
      wallNow: fixedWallNow,
    })

    for (const record of result.records) expect(() => parseTranscriptRecord(record)).not.toThrow()

    expect(result.records.map((record) => record.seq)).toEqual(
      result.records.map((_record, index) => index),
    )
    expect(result.records[0]?.kind).toBe('turn.granted')
    expect(result.records.at(-1)?.kind).toBe('session.completed')

    const personaTurns = task.content.turns.filter((turn) => turn.role === 'persona')
    const kinds = result.records.map((record) => record.kind)

    expect(kinds.filter((kind) => kind === 'turn.granted')).toHaveLength(personaTurns.length)
    expect(kinds.filter((kind) => kind === 'persona.response.started')).toHaveLength(
      personaTurns.length,
    )
    expect(kinds.filter((kind) => kind === 'persona.response.committed')).toHaveLength(
      personaTurns.length,
    )
    expect(kinds.filter((kind) => kind === 'turn.revoked')).toHaveLength(0)
    expect(result.providerRequests).toBe(personaTurns.length)

    const committedTexts = result.records
      .filter((record) => record.kind === 'persona.response.committed')
      .map((record) => (record.payload as { text: string }).text)
    expect(committedTexts).toEqual(personaTurns.map((turn) => turn.text))

    // Streamed chunks concatenate back to the committed response, in order.
    const chunksByGrant = new Map<string, string>()
    for (const record of result.records) {
      if (record.kind !== 'persona.response.chunk') continue
      const payload = record.payload as { grantId: string; text: string }
      chunksByGrant.set(
        payload.grantId,
        `${chunksByGrant.get(payload.grantId) ?? ''}${payload.text}`,
      )
    }
    const committedByGrant = new Map<string, string>()
    for (const record of result.records) {
      if (record.kind !== 'persona.response.committed') continue
      const payload = record.payload as { grantId: string; text: string }
      committedByGrant.set(payload.grantId, payload.text)
    }
    expect([...chunksByGrant.entries()]).toEqual([...committedByGrant.entries()])
  })

  it('skips empty chunks and does not advance the sequence', async () => {
    const task = loadTask(taskPaths[0])
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'empty-chunk',
      async *complete() {
        yield { text: '', done: false }
        yield { text: 'ok', done: true }
      },
    }

    const result = await replayTask({
      runId: 'empty-chunk-test',
      executionId: EXECUTION_ID,
      task,
      clock: new FakeClock(0),
      provider,
      wallNow: fixedWallNow,
    })

    const chunks = result.records
      .filter((record) => record.kind === 'persona.response.chunk')
      .map((record) => record.payload as { text: string; sequence: number })

    expect(chunks.map((chunk) => chunk.text)).toEqual(
      task.content.turns.filter((turn) => turn.role === 'persona').map(() => 'ok'),
    )
    expect(chunks.every((chunk) => chunk.sequence === 0)).toBe(true)
  })

  it.each(taskPaths)(
    'classifies content correctly and derives expiry from the clock for %s',
    async (relativePath) => {
      const task = loadTask(relativePath)
      const result = await replayTask({
        runId: 'content-class-test',
        executionId: EXECUTION_ID,
        task,
        clock: new FakeClock(0),
        provider: cannedProviderFor(task),
        wallNow: fixedWallNow,
      })

      for (const record of result.records) {
        if (!isSessionEventName(record.kind)) throw new Error(`unexpected kind ${record.kind}`)
        expect(record.contentClass).toBe(expectedContentClass(record.kind))
        if (
          [
            'user.utterance.committed',
            'persona.response.chunk',
            'persona.response.committed',
          ].includes(record.kind)
        ) {
          expect(record.contentClass).toBe('restricted')
        }
      }

      for (const record of result.records) {
        if (record.kind !== 'turn.granted') continue
        const grant = (record.payload as { grant: { expiresAt: string } }).grant
        expect(Date.parse(grant.expiresAt)).toBeGreaterThan(record.tSim)
      }
    },
  )

  it('stamps the execution identity separately from the suite run id', async () => {
    const task = loadTask(taskPaths[0])
    const result = await replayTask({
      runId: 'suite-id',
      executionId: 'execution-42',
      task,
      clock: new FakeClock(0),
      provider: cannedProviderFor(task),
      wallNow: fixedWallNow,
    })

    expect(result.records.every((record) => record.runId === 'suite-id')).toBe(true)
    expect(result.records.every((record) => record.executionId === 'execution-42')).toBe(true)
  })

  it('produces byte-identical normalized transcripts for two identical replays', async () => {
    const task = loadTask(taskPaths[0])

    const first = await replayTask({
      runId: 'same-run',
      executionId: 'execution-one',
      task,
      clock: new FakeClock(0),
      provider: cannedProviderFor(task),
      wallNow: fixedWallNow,
    })
    const second = await replayTask({
      runId: 'same-run',
      executionId: 'execution-two',
      task,
      clock: new FakeClock(0),
      provider: cannedProviderFor(task),
      wallNow: () => fixedWallNow() + 999_999,
    })

    expect(second.jsonl).toBe(first.jsonl)
    expect(first.jsonl.endsWith('\n')).toBe(true)
  })

  it('fails hard when the grant expires before the response completes', async () => {
    const task = loadTask(taskPaths[0])

    await expect(
      replayTask({
        runId: 'expiry-test',
        executionId: EXECUTION_ID,
        task,
        clock: new FakeClock(0),
        provider: cannedProviderFor(task),
        wallNow: fixedWallNow,
        grantTtlMs: 1,
      }),
    ).rejects.toBeInstanceOf(ReplayError)
  })
})

describe('buildPersonaRequest', () => {
  it('builds the exact provider request for one persona turn', () => {
    const task = loadTask(taskPaths[0])

    expect(buildPersonaRequest(task, 2)).toStrictEqual({
      provider: REPLAY_PERSONA_PROVIDER,
      model: REPLAY_PERSONA_MODEL,
      messages: [
        { role: 'assistant', content: task.content.turns[0]?.text },
        { role: 'user', content: task.content.turns[1]?.text },
      ],
      metadata: { taskId: task.id, lang: task.lang, turnIndex: '2' },
    })
  })

  it('turns every earlier persona turn into assistant history', () => {
    const task = loadTask(taskPaths[0])
    const request = buildPersonaRequest(task, 4)

    expect(request.messages.map((message) => message.role)).toStrictEqual([
      'assistant',
      'user',
      'assistant',
      'user',
    ])
    expect(request.messages).toHaveLength(4)
    expect(request.messages[3]?.content).toBe(task.content.turns[3]?.text)
  })

  it('rejects a turn index with no persona turn', () => {
    const task = loadTask(taskPaths[0])

    expect(() => buildPersonaRequest(task, 1)).toThrow(
      new ReplayError(`task ${task.id} has no persona turn at index 1`),
    )
    expect(() => buildPersonaRequest(task, 99)).toThrow(
      new ReplayError(`task ${task.id} has no persona turn at index 99`),
    )
    expect(new ReplayError('boom').name).toBe('ReplayError')
  })
})

describe('replay rejection paths', () => {
  const task = loadTask(taskPaths[0])

  function replayWith(provider: CompletionProvider, options: Partial<ReplayOptions> = {}) {
    return replayTask({
      runId: 'replay-error-test',
      executionId: EXECUTION_ID,
      task,
      clock: new FakeClock(0),
      provider,
      wallNow: fixedWallNow,
      ...options,
    })
  }

  it('refuses a signal that is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      replayWith(cannedProviderFor(task), { signal: controller.signal }),
    ).rejects.toThrow(new ReplayAbortedError())
  })

  it('refuses an aborted signal before a task with no persona turn starts', async () => {
    const controller = new AbortController()
    controller.abort()
    const userOnly = withTurns([{ role: 'user', text: 'Only the learner speaks.' }])
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'unused',
      complete() {
        throw new Error('the provider must not be called for an aborted replay')
      },
    }

    await expect(
      replayTask({
        runId: 'replay-error-test',
        executionId: EXECUTION_ID,
        task: userOnly,
        clock: new FakeClock(0),
        provider,
        wallNow: fixedWallNow,
        signal: controller.signal,
      }),
    ).rejects.toThrow(ReplayAbortedError)
  })

  it('stops when the budget expires before the response stream starts', async () => {
    const controller = new AbortController()
    const base = new FakeClock(0)
    const clock = {
      now: () => base.now(),
      sleep: (ms: number) => base.sleep(ms),
      advance: async (ms: number): Promise<void> => {
        // The response-start advance (40 ms) is the last step before streaming.
        if (ms === 40) controller.abort()
        await base.advance(ms)
      },
    }

    await expect(
      replayWith(cannedProviderFor(task), { clock, signal: controller.signal }),
    ).rejects.toThrow(ReplayAbortedError)
  })

  it('stops before reading a stream that never yields after an abort', async () => {
    const controller = new AbortController()
    const base = new FakeClock(0)
    const clock = {
      now: () => base.now(),
      sleep: (ms: number) => base.sleep(ms),
      advance: async (ms: number): Promise<void> => {
        if (ms === 40) controller.abort()
        await base.advance(ms)
      },
    }
    const silent: CompletionProvider = {
      kind: 'canned',
      label: 'silent-stream',
      // No chunks at all: only the pre-stream abort check can notice the abort.
      complete() {
        return {
          [Symbol.asyncIterator]() {
            return { next: () => Promise.resolve({ value: undefined, done: true }) }
          },
        }
      },
    }

    await expect(replayWith(silent, { clock, signal: controller.signal })).rejects.toThrow(
      ReplayAbortedError,
    )
  })

  it('stops when the budget expires while a chunk is streaming', async () => {
    const controller = new AbortController()
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'post-chunk-abort',
      complete(_request, options) {
        if (options?.signal === undefined) {
          throw new Error('the replay did not pass its abort signal')
        }
        return {
          async *[Symbol.asyncIterator]() {
            yield { text: 'first', done: false }
            controller.abort()
            yield { text: 'second', done: true }
          },
        }
      },
    }

    await expect(replayWith(provider, { signal: controller.signal })).rejects.toThrow(
      ReplayAbortedError,
    )
  })

  it('rejects a chunk that arrives after the final chunk', async () => {
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'extra-chunk',
      async *complete() {
        yield { text: 'only', done: true }
        yield { text: 'late', done: true }
      },
    }

    await expect(replayWith(provider)).rejects.toThrow(
      new ReplayError('provider "extra-chunk" yielded a chunk after the final chunk'),
    )
  })

  it('rejects a stream that never marks the last chunk', async () => {
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'no-final-chunk',
      async *complete() {
        yield { text: 'partial', done: false }
      },
    }

    await expect(replayWith(provider)).rejects.toThrow(
      new ReplayError(`provider "no-final-chunk" did not mark the last chunk for ${task.id}`),
    )
  })

  it('rejects a chunk without text', async () => {
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'bad-chunk',
      async *complete() {
        yield { text: 42 as unknown as string, done: true }
      },
    }

    await expect(replayWith(provider)).rejects.toThrow(
      new ReplayError('provider "bad-chunk" yielded a chunk without text'),
    )
  })

  it('fails when the grant expires exactly at the first chunk', async () => {
    await expect(replayWith(cannedProviderFor(task), { grantTtlMs: 60 })).rejects.toThrow(
      new ReplayError(
        `grant ${task.id}-grant-0 expired before the response completed; a replay must fit its grant lifetime`,
      ),
    )
  })

  it('fails when a single-chunk response lands exactly on the grant expiry', async () => {
    await expect(
      replayWith(
        {
          kind: 'canned',
          label: 'single-chunk',
          async *complete() {
            yield { text: 'one two three', done: true }
          },
        },
        { grantTtlMs: 60 },
      ),
    ).rejects.toThrow(
      new ReplayError(
        `grant ${task.id}-grant-0 expired before the response completed; a replay must fit its grant lifetime`,
      ),
    )
  })

  it('stops when the budget expires mid-stream with no later persona turn', async () => {
    const controller = new AbortController()
    const singlePersonaTurn = withTurns([{ role: 'persona', text: 'one two three' }])
    const provider: CompletionProvider = {
      kind: 'canned',
      label: 'post-chunk-abort-single',
      async *complete() {
        yield { text: 'first', done: false }
        controller.abort()
        yield { text: 'second', done: true }
      },
    }

    await expect(
      replayTask({
        runId: 'replay-error-test',
        executionId: EXECUTION_ID,
        task: singlePersonaTurn,
        clock: new FakeClock(0),
        provider,
        wallNow: fixedWallNow,
        signal: controller.signal,
      }),
    ).rejects.toThrow(ReplayAbortedError)
  })
})

describe('replay constants', () => {
  it('pins the persona provider, model and grant lifetime', () => {
    expect(REPLAY_GRANT_TTL_MS).toBe(60_000)
    expect(REPLAY_PERSONA_PROVIDER).toBe('persona')
    expect(REPLAY_PERSONA_MODEL).toBe('canned/persona-v1')
  })
})

describe('chunkText', () => {
  it('splits on word groups and preserves the exact text', () => {
    const text = 'That works if you send me the headline numbers on Friday.'
    const chunks = chunkText(text, 3)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
  })

  it('groups exactly three words including their trailing spaces', () => {
    expect(chunkText('one two three four five six seven', 3)).toStrictEqual([
      'one two three ',
      'four five six ',
      'seven',
    ])
    expect(chunkText('one two', 3)).toStrictEqual(['one two'])
  })

  it('stops at an exact multiple of the chunk size', () => {
    expect(chunkText('one two three four five six', 3)).toStrictEqual([
      'one two three ',
      'four five six',
    ])
  })

  it('accepts one word per chunk', () => {
    expect(chunkText('one two', 1)).toStrictEqual(['one ', 'two'])
  })

  it('falls back to one chunk when leading whitespace would be lost', () => {
    expect(chunkText(' leading space', 3)).toEqual([' leading space'])
  })

  it('keeps whitespace-only text in a single chunk', () => {
    expect(chunkText('   ', 3)).toStrictEqual(['   '])
    expect(chunkText('', 3)).toStrictEqual([''])
  })

  it('rejects a chunk size below one', () => {
    expect(() => chunkText('one two', 0)).toThrow(
      new RangeError('wordsPerChunk must be at least 1: 0'),
    )
    expect(() => chunkText('one two', -2)).toThrow(
      new RangeError('wordsPerChunk must be at least 1: -2'),
    )
  })
})
