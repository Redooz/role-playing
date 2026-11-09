import { TRANSCRIPT_SCHEMA_VERSION, type SessionLogHeader } from '@rp/session-core'
import { FakeClock } from '@rp/shared'
import { describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  appendFile: vi.fn(async () => undefined),
}))

vi.mock('node:fs/promises', () => fs)

const { createFileSessionLog } = await import('./session-log.adapter.js')

const header: SessionLogHeader = {
  type: 'session.header',
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  sessionId: 'session-1',
  startedAt: '2026-11-07T10:00:00.000Z',
  clockMode: 'simulated',
  lang: 'en',
  provider: 'canned',
}

describe('file-backed session log header encoding', () => {
  it('writes the header as utf8 with exclusive creation', async () => {
    await createFileSessionLog({
      path: '/tmp/session-1.jsonl',
      header,
      clock: new FakeClock(0),
      wallClock: () => 1_700_000_000_000,
    })

    expect(fs.mkdir).toHaveBeenCalledWith('/tmp', { recursive: true })
    expect(fs.writeFile).toHaveBeenCalledWith(
      '/tmp/session-1.jsonl',
      expect.stringContaining('"type":"session.header"'),
      { encoding: 'utf8', flag: 'wx' },
    )
  })
})
