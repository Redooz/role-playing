import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  buildSessionLogRecord,
  sessionLogHeaderLine,
  sessionLogRecordLine,
  type SessionEvent,
  type SessionLogHeader,
} from '@rp/session-core'
import type { Clock } from '@rp/shared'

/**
 * File-backed append-only session log (M1 D3/D4).
 *
 * The header is written once with `wx`: a session id is minted per process and
 * must never reuse an existing file. Each event is appended as it is emitted,
 * with a strictly increasing `seq`.
 */

export interface SessionLog {
  readonly path: string
  append(event: SessionEvent): Promise<void>
}

export interface CreateFileSessionLogOptions {
  readonly path: string
  readonly header: SessionLogHeader
  readonly clock: Clock
  readonly wallClock: () => number
}

export async function createFileSessionLog(
  options: CreateFileSessionLogOptions,
): Promise<SessionLog> {
  const { path, header, clock, wallClock } = options

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${sessionLogHeaderLine(header)}\n`, { encoding: 'utf8', flag: 'wx' })

  let seq = 0

  return {
    path,
    async append(event: SessionEvent): Promise<void> {
      const record = buildSessionLogRecord({
        header,
        event,
        seq,
        tSim: clock.now(),
        tWall: wallClock(),
      })
      seq += 1
      await appendFile(path, `${sessionLogRecordLine(record)}\n`, 'utf8')
    },
  }
}
