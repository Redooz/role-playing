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
 *
 * A wall-mode session pins `tSim` to 0. `tSim` is documented as deterministic
 * simulated time; writing epoch milliseconds there would make normalized live
 * logs differ run to run. Wall time lives in `tWall`, which normalization zeros.
 *
 * After the first write failure the log is marked dead and refuses further
 * appends. A partial line can then only be the last line, which the reader
 * reports as truncation, instead of a broken interior line that every later read
 * rejects.
 */

export interface SessionLog {
  readonly path: string
  append(event: SessionEvent): Promise<void>
}

/** Injected for tests so a partial write can be simulated deterministically. */
export type AppendFile = (path: string, data: string, encoding: 'utf8') => Promise<void>

export interface CreateFileSessionLogOptions {
  readonly path: string
  readonly header: SessionLogHeader
  readonly clock: Clock
  readonly wallClock: () => number
  readonly appendFileImpl?: AppendFile
}

export async function createFileSessionLog(
  options: CreateFileSessionLogOptions,
): Promise<SessionLog> {
  const { path, header, clock, wallClock } = options
  const parsedHeader = sessionLogHeaderSchema.parse(header)
  const appendFileImpl: AppendFile =
    options.appendFileImpl ?? ((file, data, encoding) => appendFile(file, data, encoding))

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${sessionLogHeaderLine(parsedHeader)}\n`, { encoding: 'utf8', flag: 'wx' })

  let seq = 0
  let dead = false

  return {
    path,
    async append(event: SessionEvent): Promise<void> {
      if (dead) {
        throw new Error('session log is closed after a failed write; refusing further appends')
      }

      // Validation happens before the write. A rejected event is a caller bug,
      // not a broken file, so it must not kill the log.
      const record = sessionLogRecordLine(
        transcriptRecordSchema.parse(
          buildSessionLogRecord({
            header: parsedHeader,
            event,
            seq,
            tSim: parsedHeader.clockMode === 'wall' ? 0 : clock.now(),
            tWall: wallClock(),
          }),
        ),
      )

      try {
        await appendFileImpl(path, `${record}\n`, 'utf8')
      } catch (error) {
        dead = true
        throw error
      }
      seq += 1
    },
  }
}
