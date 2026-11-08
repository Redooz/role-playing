import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  buildSessionLogRecord,
  sessionLogHeaderLine,
  sessionLogHeaderSchema,
  sessionLogRecordLine,
  transcriptRecordSchema,
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
  const parsedHeader = sessionLogHeaderSchema.parse(header)

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${sessionLogHeaderLine(parsedHeader)}\n`, { encoding: 'utf8', flag: 'wx' })

  let seq = 0

  return {
    path,
    async append(event: SessionEvent): Promise<void> {
      const record = sessionLogRecordLine(
        transcriptRecordSchema.parse(
          buildSessionLogRecord({
            header: parsedHeader,
            event,
            seq,
            tSim: clock.now(),
            tWall: wallClock(),
          }),
        ),
      )
      await appendFile(path, `${record}\n`, 'utf8')
      seq += 1
    },
  }
}
