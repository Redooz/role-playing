import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TRANSCRIPT_SCHEMA_VERSION,
  parseSessionLog,
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

  it('refuses to write an invalid header', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-1.jsonl')

    await expect(
      createFileSessionLog({
        path,
        header: { ...header, taskId: '' },
        clock: new FakeClock(0),
        wallClock: () => 1_700_000_000_000,
      }),
    ).rejects.toThrow()

    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an invalid event and does not advance the sequence', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-1.jsonl')
    const log = await createFileSessionLog({
      path,
      header,
      clock: new FakeClock(0),
      wallClock: () => 1_700_000_000_000,
    })

    await expect(
      log.append({ type: 'user.utterance.committed', payload: {} } as unknown as SessionEvent),
    ).rejects.toThrow()

    await log.append({ type: 'session.completed', payload: {} })

    const stored = replaySessionLog(await readFile(path, 'utf8'))
    expect(stored.records.map((record) => record.seq)).toEqual([0])
  })

  it('refuses to reuse an existing session log', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-1.jsonl')
    const clock = new FakeClock(0)
    const options = { path, header, clock, wallClock: () => 1_700_000_000_000 }

    await createFileSessionLog(options)
    await expect(createFileSessionLog(options)).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('pins tSim to 0 in wall mode and keeps wall time in tWall', async () => {
    const dir = await tempDir()
    const path = join(dir, 'wall.jsonl')
    const wallHeader: SessionLogHeader = { ...header, clockMode: 'wall' }
    const log = await createFileSessionLog({
      path,
      header: wallHeader,
      clock: new FakeClock(1_000),
      wallClock: () => 1_700_000_000_000,
    })

    await log.append({ type: 'session.completed', payload: {} })

    const stored = parseSessionLog(await readFile(path, 'utf8'))
    expect(stored.records[0]?.tSim).toBe(0)
    expect(stored.records[0]?.tWall).toBe(1_700_000_000_000)
  })

  it('keeps the simulated clock in tSim for simulated sessions', async () => {
    const dir = await tempDir()
    const path = join(dir, 'simulated.jsonl')
    const log = await createFileSessionLog({
      path,
      header,
      clock: new FakeClock(1_000),
      wallClock: () => 1_700_000_000_000,
    })

    await log.append({ type: 'session.completed', payload: {} })

    const stored = parseSessionLog(await readFile(path, 'utf8'))
    expect(stored.records[0]?.tSim).toBe(1_000)
  })

  it('refuses further appends after a partial write', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-1.jsonl')
    let calls = 0

    const log = await createFileSessionLog({
      path,
      header,
      clock: new FakeClock(0),
      wallClock: () => 1_700_000_000_000,
      appendFileImpl: async (file, data, encoding) => {
        calls += 1
        if (calls === 1) {
          await appendFile(file, data.slice(0, Math.floor(data.length / 2)), encoding)
          throw new Error('disk full')
        }
        await appendFile(file, data, encoding)
      },
    })

    await expect(log.append({ type: 'session.completed', payload: {} })).rejects.toThrow(
      'disk full',
    )
    await expect(log.append({ type: 'session.completed', payload: {} })).rejects.toThrow(
      /closed after a failed write/,
    )

    // The cut-off line is the final line, so the reader reports truncation
    // instead of an interior malformed line that every later read rejects.
    const stored = parseSessionLog(await readFile(path, 'utf8'))
    expect(stored.truncated).toBe(true)
    expect(stored.records).toHaveLength(0)
  })
})
