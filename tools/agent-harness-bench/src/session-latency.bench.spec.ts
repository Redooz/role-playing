import { readFile } from 'node:fs/promises'
import type { GroqRequestTiming } from '@rp/pipeline'
import { createGroqTextModel } from '@rp/pipeline'
import type { TextModelChunk, TextModelPort } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import { measureSessionLatency, summarizeLatency } from './session-latency.js'
import {
  buildTextLatencyReport,
  formatLatencyTable,
  writeTextLatencyReport,
} from './session-latency-report.js'

/**
 * M1 text latency baseline (D5 / gate M1-G4).
 *
 * Runs only under the `bench` Vitest project. Live by default when
 * `GROQ_API_KEY` is present; skipped with a warning otherwise. The live run is
 * never part of a deterministic gate and freezes no budget.
 *
 * Defaults: 20 sessions × 5 turns = 100 measured turns, plus one warmup turn.
 * `LATENCY_SESSIONS` / `LATENCY_TURNS_PER_SESSION` override the size;
 * `LATENCY_SKIP_WARMUP=1` skips the warmup.
 */

const apiKey = process.env['GROQ_API_KEY']
const hasKey = apiKey !== undefined && apiKey.trim() !== ''
const describeLive = hasKey ? describe : describe.skip

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new RangeError(`${name} must be a positive integer, received: ${raw}`)
  }
  return parsed
}

const SESSIONS = positiveInteger('LATENCY_SESSIONS', 20)
const TURNS_PER_SESSION = positiveInteger('LATENCY_TURNS_PER_SESSION', 5)
const WARMUP = process.env['LATENCY_SKIP_WARMUP'] === '1' ? 0 : 1
const THROTTLE_MS = positiveInteger('LATENCY_THROTTLE_MS', 3000)

const PROMPT = 'Reply with exactly one word: ok.'

function captureErrors(base: TextModelPort, errors: unknown[]): TextModelPort {
  return {
    kind: base.kind,
    label: base.label,
    complete(request, options): AsyncIterableIterator<TextModelChunk> {
      const source = base.complete(request, options)[Symbol.asyncIterator]()
      return {
        [Symbol.asyncIterator]() {
          return this
        },
        async next() {
          try {
            return await source.next()
          } catch (error) {
            errors.push(error)
            throw error
          }
        },
        async return(value?: unknown) {
          if (source.return === undefined) return { done: true, value: undefined }
          return source.return(value)
        },
      }
    },
    ...(base.dispose === undefined ? {} : { dispose: () => base.dispose?.() }),
  }
}

function createFactory(key: string) {
  return () => {
    const timings: GroqRequestTiming[] = []
    const errors: unknown[] = []
    const model = captureErrors(
      createGroqTextModel({
        apiKey: key,
        onTiming: (timing) => timings.push(timing),
      }),
      errors,
    )
    return { model, timings, errors }
  }
}

describeLive('M1 text latency (live Groq)', () => {
  it(
    'measures at least 100 turns and writes the baseline report',
    { timeout: 20 * 60_000 },
    async () => {
      const key = apiKey as string
      const factory = createFactory(key)
      const measuredTurns = SESSIONS * TURNS_PER_SESSION

      if (WARMUP > 0) {
        await measureSessionLatency({
          modelFactory: factory,
          sessions: WARMUP,
          turnsPerSession: 1,
          prompt: () => PROMPT,
        })
      }

      const measurement = await measureSessionLatency({
        modelFactory: factory,
        sessions: SESSIONS,
        turnsPerSession: TURNS_PER_SESSION,
        prompt: () => PROMPT,
        throttleMs: THROTTLE_MS,
      })

      const summary = summarizeLatency(measurement)
      const report = buildTextLatencyReport({
        measurement,
        summary,
        sessions: SESSIONS,
        turnsPerSession: TURNS_PER_SESSION,
        throttleMs: THROTTLE_MS,
      })
      const written = await writeTextLatencyReport(report)

      console.log(
        `\nM1 text latency — ${report.turnsMeasured}/${measuredTurns} turns measured, ` +
          `${report.failures.length} failure(s), ${report.sessions} sessions`,
      )
      for (const line of formatLatencyTable(report)) console.log(line)
      console.log(
        `${report.environment.node} · ${report.environment.platform}/${report.environment.arch} · ${report.environment.cpuModel}`,
      )
      console.log(`Report: ${written.path}\n`)

      expect(report.turnsMeasured).toBe(measuredTurns)
      expect(report.metrics.turnTtftMs.count).toBe(measuredTurns)
      expect(report.metrics.turnTotalMs.count).toBe(measuredTurns)
      expect(report.metrics.sessionStartToFirstChunkMs.count).toBe(SESSIONS)
      expect(report.failures).toHaveLength(0)
      expect(report.budgetFrozen).toBe(false)

      const persisted = JSON.parse(await readFile(written.path, 'utf8')) as {
        suite: string
        turnsMeasured: number
      }
      expect(persisted.suite).toBe('m1-text-latency')
      expect(persisted.turnsMeasured).toBe(measuredTurns)
    },
  )
})

if (!hasKey) {
  console.warn(
    'M1 text latency bench skipped: GROQ_API_KEY is not set. Add it to .env and rerun npm run test:bench.',
  )
}
