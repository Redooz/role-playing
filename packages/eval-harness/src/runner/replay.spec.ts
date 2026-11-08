import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FakeClock } from '@rp/shared'
import { expectedContentClass, isSessionEventName, parseTranscriptRecord } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import { taskEntrySchema, type TaskEntry } from '../tasks/schema.js'
import { createCannedProvider, type CompletionProvider } from './canned-provider.js'
import { ReplayError, buildCannedEntriesForTask, chunkText, replayTask } from './replay.js'

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

describe('chunkText', () => {
  it('splits on word groups and preserves the exact text', () => {
    const text = 'That works if you send me the headline numbers on Friday.'
    const chunks = chunkText(text, 3)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
  })

  it('falls back to one chunk when leading whitespace would be lost', () => {
    expect(chunkText(' leading space', 3)).toEqual([' leading space'])
  })
})
