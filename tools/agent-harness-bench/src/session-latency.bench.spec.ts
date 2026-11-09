import { readFile } from 'node:fs/promises'
import type { TextRequestTiming } from '@rp/pipeline'
import {
  GROQ_BASE_URL,
  GROQ_PERSONA_MODEL,
  LIVEKIT_GEMMA_MODEL,
  LIVEKIT_INFERENCE_DEFAULT_BASE_URL,
  OPENROUTER_BASE_URL,
  OPENROUTER_PROBE_MODEL,
  createGroqTextModel,
  createLiveKitInferenceTextModel,
  createOpenRouterTextModel,
} from '@rp/pipeline'
import type { TextModelChunk, TextModelPort } from '@rp/session-core'
import { describe, expect, it } from 'vitest'
import { measureSessionLatency, summarizeLatency } from './session-latency.js'
import {
  DEFAULT_TEXT_LATENCY_REPORT_PATH,
  buildTextLatencyReport,
  formatLatencyTable,
  modelSlug,
  probeTextLatencyReportPath,
  writeTextLatencyReport,
} from './session-latency-report.js'

/**
 * M1 text latency bench (D5 / gate M1-G4).
 *
 * Runs only under the `bench` Vitest project. The default is the M1 baseline:
 * live Groq `openai/gpt-oss-20b`. Set `LATENCY_PROVIDER=openrouter` or
 * `LATENCY_PROVIDER=livekit` and `LATENCY_MODEL=<id>` to measure a comparison
 * model; that run is written to the probe path and never overwrites the
 * baseline.
 *
 * Defaults: 20 sessions × 5 turns = 100 measured turns, plus one warmup turn.
 * `LATENCY_SESSIONS` / `LATENCY_TURNS_PER_SESSION` override the size;
 * `LATENCY_SKIP_WARMUP=1` skips the warmup; `LATENCY_THROTTLE_MS` controls the
 * gap between requests (the Groq free tier allows 8,000 tokens/minute).
 */

type Provider = 'groq' | 'openrouter' | 'livekit'

function resolveProvider(): Provider {
  const raw = process.env['LATENCY_PROVIDER'] ?? 'groq'
  if (raw !== 'groq' && raw !== 'openrouter' && raw !== 'livekit') {
    throw new RangeError(
      `LATENCY_PROVIDER must be "groq", "openrouter" or "livekit", received: ${raw}`,
    )
  }
  return raw
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new RangeError(`${name} must be a positive integer, received: ${raw}`)
  }
  return parsed
}

const PROVIDER = resolveProvider()
const MODEL =
  process.env['LATENCY_MODEL'] ??
  (PROVIDER === 'groq'
    ? GROQ_PERSONA_MODEL
    : PROVIDER === 'livekit'
      ? LIVEKIT_GEMMA_MODEL
      : OPENROUTER_PROBE_MODEL)
const CREDENTIAL_NAMES =
  PROVIDER === 'groq'
    ? ['GROQ_API_KEY']
    : PROVIDER === 'livekit'
      ? ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']
      : ['OPENROUTER_API_KEY']
const hasKey = CREDENTIAL_NAMES.every((name) => {
  const value = process.env[name]
  return value !== undefined && value.trim() !== ''
})
const describeLive = hasKey ? describe : describe.skip

const SESSIONS = positiveInteger('LATENCY_SESSIONS', 20)
const TURNS_PER_SESSION = positiveInteger('LATENCY_TURNS_PER_SESSION', 5)
const WARMUP = process.env['LATENCY_SKIP_WARMUP'] === '1' ? 0 : 1
const THROTTLE_MS = positiveInteger('LATENCY_THROTTLE_MS', 3000)

const IS_BASELINE = PROVIDER === 'groq' && MODEL === GROQ_PERSONA_MODEL
const SUITE = IS_BASELINE
  ? 'm1-text-latency'
  : `m1-text-latency-probe-${PROVIDER}-${modelSlug(MODEL)}`
const REPORT_PATH = IS_BASELINE
  ? DEFAULT_TEXT_LATENCY_REPORT_PATH
  : probeTextLatencyReportPath(MODEL, PROVIDER)
const NOTE = IS_BASELINE
  ? 'Wall-clock text proxy: session start -> first text chunk. No audio exists in M1. No latency budget is frozen.'
  : `Comparison probe on ${PROVIDER} ${MODEL}. Not the M1 baseline; the product persona model remains Groq ${GROQ_PERSONA_MODEL}. Wall-clock text proxy; no budget is frozen.`

const PROMPT = 'Reply with exactly one word: ok.'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required for the ${PROVIDER} latency probe`)
  }
  return value
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

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

function createModel(onTiming: (timing: TextRequestTiming) => void): TextModelPort {
  if (PROVIDER === 'groq') {
    return createGroqTextModel({
      apiKey: requireEnv('GROQ_API_KEY'),
      baseUrl: optionalEnv('GROQ_BASE_URL') ?? GROQ_BASE_URL,
      onTiming,
    })
  }
  if (PROVIDER === 'livekit') {
    return createLiveKitInferenceTextModel({
      apiKey: requireEnv('LIVEKIT_API_KEY'),
      apiSecret: requireEnv('LIVEKIT_API_SECRET'),
      model: MODEL,
      baseUrl: optionalEnv('LIVEKIT_INFERENCE_URL') ?? LIVEKIT_INFERENCE_DEFAULT_BASE_URL,
      onTiming,
    })
  }
  return createOpenRouterTextModel({
    apiKey: requireEnv('OPENROUTER_API_KEY'),
    model: MODEL,
    baseUrl: optionalEnv('OPENROUTER_BASE_URL') ?? OPENROUTER_BASE_URL,
    appName: 'role-playing-latency-bench',
    onTiming,
  })
}

function createFactory() {
  return () => {
    const timings: TextRequestTiming[] = []
    const errors: unknown[] = []
    const base = createModel((timing) => timings.push(timing))
    const model = captureErrors(base, errors)
    return { model, timings, errors }
  }
}

describeLive(`M1 text latency (${PROVIDER}/${MODEL})`, () => {
  it('measures at least 100 turns and writes the report', { timeout: 20 * 60_000 }, async () => {
    const factory = createFactory()
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
      suite: SUITE,
      note: NOTE,
      provider: PROVIDER,
      model: MODEL,
      sessions: SESSIONS,
      turnsPerSession: TURNS_PER_SESSION,
      throttleMs: THROTTLE_MS,
    })
    const written = await writeTextLatencyReport(report, REPORT_PATH)

    console.log(
      `\nM1 text latency — ${PROVIDER}/${MODEL} — ` +
        `${report.turnsMeasured}/${measuredTurns} turns measured, ` +
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
    expect(persisted.suite).toBe(SUITE)
    expect(persisted.turnsMeasured).toBe(measuredTurns)
  })
})

if (!hasKey) {
  console.warn(
    `M1 text latency bench skipped: ${CREDENTIAL_NAMES.join(' and ')} not set. Add them to .env and rerun npm run test:bench.`,
  )
}
