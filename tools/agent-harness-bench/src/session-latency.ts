import { performance } from 'node:perf_hooks'
import type { GroqRequestTiming } from '@rp/pipeline'
import { createTextSessionDriver, type SessionDriver, type TextModelPort } from '@rp/session-core'
import { SystemClock } from '@rp/shared'
import { summarizeDurations, type PercentileSummary } from './percentiles.js'

/**
 * Wall-clock text latency measurement (M1 D5).
 *
 * This is a benchmark, not engine code: `performance.now()` is the correct
 * clock here, while the session transcript keeps simulated time. The measured
 * quantities are:
 *
 * - **session start → first text chunk** — labelled a text proxy, never a
 *   time-to-first-word claim;
 * - **utterance committed → first chunk** (TTFT) and **→ committed** (total),
 *   per turn;
 * - **provider time** (request → first content) and **local overhead** (driver
 *   and event-loop time) where the adapter reports its boundary.
 *
 * No budget is frozen anywhere in this module. The report records measurements
 * and sample counts only.
 */

export interface LatencyModel {
  readonly model: TextModelPort
  /** Filled by the adapter's `onTiming`; one entry per model call. */
  readonly timings: GroqRequestTiming[]
  /** Adapter errors captured by an instrumented factory, for failure diagnosis. */
  readonly errors?: unknown[]
}

export type LatencyModelFactory = () => LatencyModel

export interface MeasureSessionLatencyOptions {
  readonly modelFactory: LatencyModelFactory
  readonly sessions: number
  readonly turnsPerSession: number
  readonly prompt: (sessionIndex: number, turnIndex: number) => string
  /** Wall clock, injectable for tests. */
  readonly now?: () => number
  /** Abort a turn that stalls. Defaults to 60 seconds. */
  readonly turnTimeoutMs?: number
  /**
   * Minimum gap between model requests. The free Groq tier allows 8,000
   * tokens/minute; un-paced turns trigger HTTP 429 and produce no sample.
   */
  readonly throttleMs?: number
}

export interface TurnSample {
  readonly sessionIndex: number
  readonly turnIndex: number
  readonly ttftMs: number
  readonly totalMs: number
  readonly providerTtftMs?: number
  readonly localOverheadMs?: number
}

export interface SessionStartSample {
  readonly sessionIndex: number
  readonly ms: number
}

export interface TurnFailure {
  readonly sessionIndex: number
  readonly turnIndex: number
  readonly reason: 'timeout' | 'error' | 'cancelled' | 'empty'
  readonly message?: string
}

export interface LatencyMeasurement {
  readonly turns: readonly TurnSample[]
  readonly sessionStarts: readonly SessionStartSample[]
  readonly failures: readonly TurnFailure[]
}

interface MutableTurn {
  readonly sessionIndex: number
  readonly turnIndex: number
  readonly utteranceAt: number
  ttftMs?: number
  totalMs?: number
  providerTtftMs?: number
  localOverheadMs?: number
}

const DEFAULT_TURN_TIMEOUT_MS = 60_000

export async function measureSessionLatency(
  options: MeasureSessionLatencyOptions,
): Promise<LatencyMeasurement> {
  const now = options.now ?? (() => performance.now())
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  const throttleMs = options.throttleMs ?? 0
  const turns: MutableTurn[] = []
  const sessionStarts: SessionStartSample[] = []
  const failures: TurnFailure[] = []

  for (let sessionIndex = 0; sessionIndex < options.sessions; sessionIndex += 1) {
    // Pace between sessions outside the measured session-start window.
    if (sessionIndex > 0 && throttleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, throttleMs))
    }

    const { model, timings, errors: modelErrors } = options.modelFactory()
    const sessionStartedAt = now()
    const driver = createTextSessionDriver({
      sessionId: `latency-${sessionIndex}`,
      lang: 'en',
      clockMode: 'wall',
      clock: new SystemClock(),
      model,
    })

    let pendingTurn: MutableTurn | undefined
    let completedTurn: MutableTurn | undefined
    let sessionFirstChunkAt: number | undefined
    let turnState: { emptyCommit: boolean; cancellation?: string } = { emptyCommit: false }
    let turnSettled = Promise.withResolvers<void>()

    const consumer = (async () => {
      for await (const event of driver.events) {
        const at = now()

        switch (event.type) {
          case 'persona.response.chunk':
            if (sessionFirstChunkAt === undefined) {
              sessionFirstChunkAt = at
              sessionStarts.push({ sessionIndex, ms: at - sessionStartedAt })
            }
            if (pendingTurn !== undefined && pendingTurn.ttftMs === undefined) {
              pendingTurn.ttftMs = at - pendingTurn.utteranceAt
            }
            break
          case 'persona.response.committed':
            if (pendingTurn !== undefined) {
              pendingTurn.totalMs = at - pendingTurn.utteranceAt
              if (pendingTurn.ttftMs === undefined) {
                turnState.emptyCommit = true
              } else {
                completedTurn = pendingTurn
                turns.push(pendingTurn)
              }
              pendingTurn = undefined
            }
            turnSettled.resolve()
            break
          case 'persona.response.cancelled':
            turnState.cancellation = event.payload.reason
            pendingTurn = undefined
            turnSettled.resolve()
            break
          default:
            break
        }
      }
    })()

    try {
      for (let turn = 0; turn < options.turnsPerSession; turn += 1) {
        if (turn > 0 && throttleMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, throttleMs))
        }
        const timingCount = timings.length
        const errorCount = modelErrors?.length ?? 0
        turnSettled = Promise.withResolvers<void>()
        turnState = { emptyCommit: false }
        // Align the turn clock with the provider clock: the utterance is
        // committed synchronously inside send(), before the model request starts.
        pendingTurn = { sessionIndex, turnIndex: turn, utteranceAt: now() }
        const { status, error } = await sendWithTimeout(
          driver,
          options.prompt(sessionIndex, turn),
          turnTimeoutMs,
        )
        if (error !== undefined) turnSettled.resolve()
        await turnSettled.promise

        const sample =
          completedTurn !== undefined && completedTurn.turnIndex === turn
            ? completedTurn
            : undefined

        if (sample === undefined || sample.ttftMs === undefined) {
          const captured = modelErrors?.[errorCount]
          const message =
            captured !== undefined
              ? messageOf(captured)
              : turnState.emptyCommit
                ? 'response committed without a text chunk'
                : turnState.cancellation
          failures.push({
            sessionIndex,
            turnIndex: turn,
            reason:
              status === 'timeout'
                ? 'timeout'
                : error !== undefined
                  ? 'error'
                  : turnState.emptyCommit
                    ? 'empty'
                    : 'cancelled',
            ...(message === undefined ? {} : { message }),
            ...(error === undefined ? {} : { message: messageOf(error) }),
          })
          completedTurn = undefined
          continue
        }

        const timing = timings[timingCount]
        if (timing?.firstContentAt !== undefined) {
          const providerTtftMs = timing.firstContentAt - timing.requestStartedAt
          sample.providerTtftMs = providerTtftMs
          sample.localOverheadMs = sample.ttftMs - providerTtftMs
        }
        completedTurn = undefined
      }
    } finally {
      await driver.close()
      await consumer
    }
  }

  return {
    turns: turns.map((turn) => ({
      sessionIndex: turn.sessionIndex,
      turnIndex: turn.turnIndex,
      ttftMs: turn.ttftMs as number,
      totalMs: turn.totalMs as number,
      ...(turn.providerTtftMs === undefined ? {} : { providerTtftMs: turn.providerTtftMs }),
      ...(turn.localOverheadMs === undefined ? {} : { localOverheadMs: turn.localOverheadMs }),
    })),
    sessionStarts,
    failures,
  }
}

export interface LatencySummary {
  readonly sessionStartToFirstChunkMs: PercentileSummary
  readonly turnTtftMs: PercentileSummary
  readonly turnTotalMs: PercentileSummary
  readonly providerTtftMs: PercentileSummary | undefined
  readonly localOverheadMs: PercentileSummary | undefined
}

/** Summarize a measurement. Fails on an empty sample rather than inventing one. */
export function summarizeLatency(measurement: LatencyMeasurement): LatencySummary {
  const sessionStarts = measurement.sessionStarts.map((sample) => sample.ms)
  const ttft = measurement.turns.map((turn) => turn.ttftMs)
  const total = measurement.turns.map((turn) => turn.totalMs)
  const provider = measurement.turns.flatMap((turn) =>
    turn.providerTtftMs === undefined ? [] : [turn.providerTtftMs],
  )
  const local = measurement.turns.flatMap((turn) =>
    turn.localOverheadMs === undefined ? [] : [turn.localOverheadMs],
  )

  return {
    sessionStartToFirstChunkMs: summarizeDurations(sessionStarts),
    turnTtftMs: summarizeDurations(ttft),
    turnTotalMs: summarizeDurations(total),
    providerTtftMs: provider.length === 0 ? undefined : summarizeDurations(provider),
    localOverheadMs: local.length === 0 ? undefined : summarizeDurations(local),
  }
}

interface SendOutcome {
  readonly status: 'ok' | 'timeout'
  readonly error: unknown
}

async function sendWithTimeout(
  driver: SessionDriver,
  text: string,
  timeoutMs: number,
): Promise<SendOutcome> {
  let error: unknown
  const sending = driver.send(text).catch((caught: unknown) => {
    error = caught
  })

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })

  const outcome = await Promise.race([sending.then(() => 'ok' as const), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })

  if (outcome === 'timeout') {
    await driver.interrupt()
    await sending
  }

  return { status: outcome === 'timeout' ? 'timeout' : 'ok', error }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
