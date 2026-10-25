import type { TraceRecord } from '@rp/session-core'
import { canonicalJson, FakeClock, MemoryTraceSink } from '@rp/shared'

/**
 * The three M0 harness-overhead workloads (D7 / gate G5).
 *
 * Each workload is pure and depends only on `@rp/shared`: no network, no
 * filesystem, no session engine. They measure harness plumbing, not product
 * behavior, and no latency budget is frozen at M0.
 */

/** A synchronous workload plus optional untimed per-iteration preparation. */
export interface SyncWorkload {
  readonly name: string
  readonly beforeEach?: () => void
  readonly run: () => void
}

/** An asynchronous workload plus optional untimed per-iteration preparation. */
export interface AsyncWorkload {
  readonly name: string
  readonly beforeEach?: () => void
  readonly run: () => Promise<void>
}

/** Default number of sleepers a fake-clock dispatch iteration advances past. */
export const DEFAULT_FAKE_CLOCK_SLEEPERS = 100

/** How far the fake clock advances per iteration; comfortably past every sleeper. */
const FAKE_CLOCK_ADVANCE_MS = 1_000

/**
 * Fake-clock dispatch: register many sleepers, then time only the `advance`
 * call that wakes them. Registration happens in `beforeEach`, outside the timed
 * section, so the measurement isolates dispatch cost.
 */
export function createFakeClockDispatchWorkload(
  sleeperCount = DEFAULT_FAKE_CLOCK_SLEEPERS,
): AsyncWorkload {
  if (!Number.isInteger(sleeperCount) || sleeperCount < 1) {
    throw new RangeError(`Sleeper count must be a positive integer: ${sleeperCount}`)
  }

  let clock = new FakeClock()

  return {
    name: 'fake-clock dispatch',
    beforeEach() {
      clock = new FakeClock()
      for (let index = 0; index < sleeperCount; index += 1) {
        // Sleepers are consumed by the timed advance; retaining the promises is
        // unnecessary and would only add bookkeeping outside what we measure.
        void clock.sleep(1 + (index % 50))
      }
    },
    async run() {
      await clock.advance(FAKE_CLOCK_ADVANCE_MS)
    },
  }
}

const SAMPLE_PERSONA_TEXT =
  'I appreciate you raising that — let us compare the timeline and the budget before we commit.'

/** Build one representative, schema-valid trace record for the benchmarks. */
export function createTraceRecord(seq = 1): TraceRecord {
  return {
    schemaVersion: '1.0.0',
    runId: 'm0-harness-overhead',
    seq,
    tSim: 1_234.5,
    tWall: 1_700_000_000_000,
    kind: 'persona.response.chunk',
    payload: {
      grantId: 'grant-0001',
      text: SAMPLE_PERSONA_TEXT,
      sequence: seq,
    },
    contentClass: 'public',
  }
}

/**
 * Event serialization: canonical JSON of a trace-record-shaped persona response
 * event, including the nested payload and `contentClass`.
 */
export function createEventSerializationWorkload(): SyncWorkload {
  const record = createTraceRecord()

  return {
    name: 'event serialization',
    run() {
      // `void` keeps the result out of the report while still forcing the call.
      void canonicalJson(record)
    },
  }
}

const TRACE_APPEND_RECORD_COUNT = 64

/**
 * Trace append: append pre-built trace records to an in-memory sink. Records
 * are prepared outside the timed section; the measurement is the sink call.
 */
export function createTraceAppendWorkload(): SyncWorkload {
  const sink = new MemoryTraceSink<TraceRecord>()
  const records = Array.from({ length: TRACE_APPEND_RECORD_COUNT }, (_, index) =>
    createTraceRecord(index + 1),
  )
  let cursor = 0

  return {
    name: 'trace append',
    run() {
      const record = records[cursor]
      cursor = (cursor + 1) % records.length
      if (record !== undefined) sink.append(record)
    },
  }
}
