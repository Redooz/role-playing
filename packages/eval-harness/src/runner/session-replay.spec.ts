import { FakeClock } from '@rp/shared'
import {
  TRANSCRIPT_SCHEMA_VERSION,
  createTextSessionDriver,
  expectedContentClass,
  normalizedTranscriptJsonl,
  type SessionEvent,
  type TranscriptRecord,
} from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import { createCannedProvider, type CompletionRequest } from './canned-provider.js'
import { createCompletionProviderTextModel } from './text-model.adapter.js'

/**
 * M1-G1 evidence: a full text session, driven through the session driver and a
 * canned model, produces byte-identical normalized transcripts across runs even
 * when the wall clock and execution identity differ.
 */

const RUN_ID = 'm1-text-session'
const WALL_CLOCK = 1_700_000_000_000

function recordedRequest(text: string, lang = 'en'): CompletionRequest {
  return {
    provider: 'persona',
    model: 'canned/persona-v1',
    messages: [{ role: 'user', content: text }],
    metadata: { taskId: 'task-1', lang },
  }
}

async function recordSession(options: {
  readonly text: string
  readonly reply: readonly string[]
  readonly executionId: string
  readonly tWall: number
}): Promise<string> {
  const provider = createCannedProvider([
    { request: recordedRequest(options.text), chunks: options.reply },
  ])
  const model = createCompletionProviderTextModel({
    provider,
    metadata: { taskId: 'task-1' },
  })
  const clock = new FakeClock(0)
  const driver = createTextSessionDriver({
    sessionId: 'session-1',
    lang: 'en',
    clock,
    model,
  })

  const records: TranscriptRecord[] = []
  let seq = 0
  const append = (event: SessionEvent): void => {
    records.push({
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      runId: RUN_ID,
      executionId: options.executionId,
      seq,
      tSim: clock.now(),
      tWall: options.tWall,
      kind: event.type,
      payload: event.payload,
      contentClass: expectedContentClass(event.type),
    })
    seq += 1
  }

  const consumer = (async () => {
    for await (const event of driver.events) append(event)
  })()

  await driver.send(options.text)
  await driver.close()
  await consumer

  return normalizedTranscriptJsonl(records)
}

describe('text session replay over driver events', () => {
  it('reproduces a byte-identical normalized transcript across executions', async () => {
    const first = await recordSession({
      text: 'hello',
      reply: ['Hello ', 'there'],
      executionId: 'execution-one',
      tWall: WALL_CLOCK,
    })
    const second = await recordSession({
      text: 'hello',
      reply: ['Hello ', 'there'],
      executionId: 'execution-two',
      tWall: WALL_CLOCK + 9_999,
    })

    expect(second).toBe(first)
    expect(first.endsWith('\n')).toBe(true)
    expect(first.split('\n').filter(Boolean)).toHaveLength(9)
  })

  it('records session start and a committed reply under an implicit grant', async () => {
    const jsonl = await recordSession({
      text: 'hello',
      reply: ['Hello ', 'there'],
      executionId: 'execution-one',
      tWall: WALL_CLOCK,
    })
    const records = jsonl
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as TranscriptRecord)

    expect(records.map((record) => record.kind)).toEqual([
      'session.started',
      'user.utterance.committed',
      'turn.opened',
      'turn.granted',
      'persona.response.started',
      'persona.response.chunk',
      'persona.response.chunk',
      'persona.response.committed',
      'session.completed',
    ])
    expect(records[0]?.contentClass).toBe('contentFree')
    expect(records[5]?.contentClass).toBe('restricted')
  })
})
