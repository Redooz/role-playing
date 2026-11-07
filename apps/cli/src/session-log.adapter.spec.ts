import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TRANSCRIPT_SCHEMA_VERSION,
  replaySessionLog,
  type SessionEvent,
  type SessionLogHeader,
} from '@rp/session-core'
import { FakeClock } from '@rp/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileSessionLog } from './session-log.adapter.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rp-session-log-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const header: SessionLogHeader = {
  type: 'session.header',
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  sessionId: 'session-1',
  startedAt: '2026-11-07T10:00:00.000Z',
  clockMode: 'simulated',
  lang: 'en',
  provider: 'canned/demo',
  taskId: 'task-1',
}

describe('file-backed session log', () => {
  it('writes the header first and appends every event in order', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-1.jsonl')
    const clock = new FakeClock(0)

    const log = await createFileSessionLog({
      path,
      header,
      clock,
      wallClock: () => 1_700_000_000_000,
    })

    const events: SessionEvent[] = [
      {
        type: 'session.started',
        payload: { sessionId: 'session-1', clockMode: 'simulated', lang: 'en' },
      },
      { type: 'user.utterance.committed', payload: { text: 'hello' } },
      { type: 'session.completed', payload: {} },
    ]

    for (const event of events) await log.append(event)

    const stored = replaySessionLog(await readFile(path, 'utf8'))
    expect(stored.header).toEqual(header)
    expect(stored.events).toEqual(events)
    expect(stored.records.map((record) => record.seq)).toEqual([0, 1, 2])
    expect(stored.records.every((record) => record.runId === 'session-1')).toBe(true)
    expect(stored.truncated).toBe(false)
  })

  it('refuses to reuse an existing session log', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-1.jsonl')
    const clock = new FakeClock(0)
    const options = { path, header, clock, wallClock: () => 1_700_000_000_000 }

    await createFileSessionLog(options)
    await expect(createFileSessionLog(options)).rejects.toMatchObject({ code: 'EEXIST' })
  })
})
