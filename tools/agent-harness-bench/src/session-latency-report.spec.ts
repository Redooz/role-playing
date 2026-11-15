import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { isAbsolute, join, sep } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PercentileSummary } from './percentiles.js'
import type { LatencyMeasurement, LatencySummary, TurnFailure } from './session-latency.js'
import {
  DEFAULT_TEXT_LATENCY_REPORT_PATH,
  buildTextLatencyReport,
  formatLatencyTable,
  modelSlug,
  probeTextLatencyReportPath,
  writeTextLatencyReport,
  type TextLatencyReport,
} from './session-latency-report.js'

const cpuState = vi.hoisted(() => ({
  processors: [] as Array<{ model: string }>,
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, cpus: () => cpuState.processors }
})

afterEach(() => {
  cpuState.processors = []
  vi.useRealTimers()
})

function summary(
  count: number,
  min: number,
  max: number,
  mean: number,
  p50: number,
  p95: number,
  p99: number,
): PercentileSummary {
  return { count, min, max, mean, p50, p95, p99 }
}

function fullMetrics(): LatencySummary {
  return {
    sessionStartToFirstChunkMs: summary(2, 10, 20, 15, 15, 19.5, 19.9),
    turnTtftMs: summary(3, 2, 9, 5, 5, 8.8, 8.96),
    turnTotalMs: summary(3, 20, 30, 25, 25, 29.6, 29.94),
    providerTtftMs: summary(2, 0.5, 1.5, 1, 1, 1.46, 1.49),
    localOverheadMs: summary(1, 0, 0, 0, 0, 0, 0),
  }
}

function report(metrics: LatencySummary = fullMetrics()): TextLatencyReport {
  return {
    schemaVersion: 1,
    suite: 'm1-text-latency',
    note: 'measured only',
    budgetFrozen: false,
    generatedAt: '2026-11-14T00:00:00.000Z',
    provider: 'livekit',
    model: 'google/gemma-4-31b-it',
    label: 'text proxy',
    sessions: 2,
    turnsPerSession: 3,
    throttleMs: 0,
    turnsMeasured: 6,
    failures: [],
    metrics,
    environment: {
      node: 'v26.0.0',
      platform: 'linux',
      arch: 'x64',
      cpuModel: 'Test CPU',
      cpuCount: 1,
    },
  }
}

const failures: TurnFailure[] = [
  { sessionIndex: 0, turnIndex: 0, reason: 'timeout', message: 'first' },
  { sessionIndex: 1, turnIndex: 2, reason: 'empty' },
]

const measurement: LatencyMeasurement = {
  turns: [
    { sessionIndex: 0, turnIndex: 0, ttftMs: 10, totalMs: 20 },
    { sessionIndex: 1, turnIndex: 0, ttftMs: 30, totalMs: 40, providerTtftMs: 5 },
  ],
  sessionStarts: [{ sessionIndex: 0, ms: 7 }],
  failures,
}

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rp-latency-report-'))
  tempDirs.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('modelSlug', () => {
  it.each([
    ['google/gemma-4-31b-it', 'google-gemma-4-31b-it'],
    ['GPT OSS 20B', 'gpt-oss-20b'],
    ['  --Leading__Trailing--  ', 'leading-trailing'],
    ['a___b', 'a-b'],
    ['A.B_C', 'a-b-c'],
    ['groq/openai/gpt-oss-20b', 'groq-openai-gpt-oss-20b'],
    ['model-123', 'model-123'],
    ['', ''],
    ['...', ''],
    ['---abc', 'abc'],
    ['abc---', 'abc'],
  ])('slugifies %s to %s', (model, expected) => {
    expect(modelSlug(model)).toBe(expected)
  })
})

describe('probeTextLatencyReportPath', () => {
  it('puts the provider and slug into a dedicated probe directory', () => {
    const path = probeTextLatencyReportPath('google/gemma-4-31b-it', 'livekit')

    expect(isAbsolute(path)).toBe(true)
    expect(
      path.endsWith(
        join(
          'evals',
          'results',
          'm1-text-latency-probe-livekit-google-gemma-4-31b-it',
          'latency.json',
        ),
      ),
    ).toBe(true)
    expect(path.split(sep)).not.toContain('..')
  })

  it('omits the provider prefix when no provider is given', () => {
    const path = probeTextLatencyReportPath('openai/gpt-oss-20b')

    expect(
      path.endsWith(
        join('evals', 'results', 'm1-text-latency-probe-openai-gpt-oss-20b', 'latency.json'),
      ),
    ).toBe(true)
    expect(path).not.toContain('probe--')
  })
})

describe('DEFAULT_TEXT_LATENCY_REPORT_PATH', () => {
  it('points at the git-ignored M1 text latency results directory', () => {
    expect(isAbsolute(DEFAULT_TEXT_LATENCY_REPORT_PATH)).toBe(true)
    expect(
      DEFAULT_TEXT_LATENCY_REPORT_PATH.endsWith(
        join('evals', 'results', 'm1-text-latency', 'latency.json'),
      ),
    ).toBe(true)
    expect(DEFAULT_TEXT_LATENCY_REPORT_PATH.split(sep)).not.toContain('..')
    expect(DEFAULT_TEXT_LATENCY_REPORT_PATH).toBe(
      join(process.cwd(), 'evals', 'results', 'm1-text-latency', 'latency.json'),
    )
  })
})

describe('buildTextLatencyReport', () => {
  it('builds the exact report and counts measured turns, not failures', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-14T09:08:07.006Z'))
    cpuState.processors = [{ model: 'Test CPU @ 2.00GHz' }, { model: 'Second CPU' }]

    const built = buildTextLatencyReport({
      measurement,
      summary: fullMetrics(),
      suite: 'm1-text-latency',
      note: 'measured only',
      provider: 'livekit',
      model: 'google/gemma-4-31b-it',
      sessions: 2,
      turnsPerSession: 3,
      throttleMs: 250,
    })

    expect(built).toStrictEqual({
      schemaVersion: 1,
      suite: 'm1-text-latency',
      note: 'measured only',
      budgetFrozen: false,
      generatedAt: '2026-11-14T09:08:07.006Z',
      provider: 'livekit',
      model: 'google/gemma-4-31b-it',
      label: 'text proxy',
      sessions: 2,
      turnsPerSession: 3,
      throttleMs: 250,
      turnsMeasured: 2,
      failures,
      metrics: fullMetrics(),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuModel: 'Test CPU @ 2.00GHz',
        cpuCount: 2,
      },
    })
    expect(built.failures).toBe(failures)
    expect(built.metrics).toStrictEqual(fullMetrics())
  })

  it('falls back to an unknown CPU model when the host reports none', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-02T03:04:05.006Z'))

    const built = buildTextLatencyReport({
      measurement: { turns: [], sessionStarts: [], failures: [] },
      summary: fullMetrics(),
      suite: 'empty',
      note: '',
      provider: 'livekit',
      model: 'model',
      sessions: 0,
      turnsPerSession: 0,
      throttleMs: 0,
    })

    expect(built.environment.cpuModel).toBe('unknown')
    expect(built.environment.cpuCount).toBe(0)
    expect(built.turnsMeasured).toBe(0)
    expect(built.generatedAt).toBe('2026-01-02T03:04:05.006Z')
  })
})

describe('writeTextLatencyReport', () => {
  it('creates parent directories and writes the exact pretty-printed JSON', async () => {
    const built = report()
    const filePath = join(await tempDir(), 'nested', 'deeper', 'latency.json')

    const artifact = await writeTextLatencyReport(built, filePath)

    expect(artifact.report).toBe(built)
    expect(artifact.path).toBe(filePath)
    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).toBe(`${JSON.stringify(built, null, 2)}\n`)
    expect(JSON.parse(persisted) as TextLatencyReport).toStrictEqual(built)
  })
})

describe('formatLatencyTable', () => {
  it('renders every axis with its sample count and aligned columns', () => {
    expect(formatLatencyTable(report())).toEqual([
      'metric                                                         n  p50 ms  p95 ms  p99 ms  min   max ',
      'session start -> first chunk (text proxy; sessions with text)  2  15.0    19.5    19.9    10.0  20.0',
      'turn utterance -> first chunk (TTFT)                           3  5.0     8.8     9.0     2.0   9.0 ',
      'turn utterance -> committed (total)                            3  25.0    29.6    29.9    20.0  30.0',
      'provider request -> first content                              2  1.0     1.5     1.5     0.5   1.5 ',
      'local overhead (driver + event loop)                           1  0.0     0.0     0.0     0.0   0.0 ',
    ])
  })

  it('drops the provider and local rows when those axes have no sample', () => {
    const metrics: LatencySummary = {
      ...fullMetrics(),
      providerTtftMs: undefined,
      localOverheadMs: undefined,
    }

    const lines = formatLatencyTable(report(metrics))

    expect(lines).toHaveLength(4)
    expect(lines.some((line) => line.startsWith('provider'))).toBe(false)
    expect(lines.some((line) => line.startsWith('local'))).toBe(false)
    expect(lines[0]).toBe(
      'metric                                                         n  p50 ms  p95 ms  p99 ms  min   max ',
    )
  })

  it('widens the count and value columns to the longest cell', () => {
    const metrics: LatencySummary = {
      sessionStartToFirstChunkMs: summary(1_234, -5, 1_000, 1, 1, 2, 3),
      turnTtftMs: summary(1, 0, 0, 0, 0, 0, 0),
      turnTotalMs: summary(1, 0, 0, 0, 0, 0, 0),
      providerTtftMs: undefined,
      localOverheadMs: undefined,
    }

    const lines = formatLatencyTable(report(metrics))

    expect(lines[1]).toBe(
      'session start -> first chunk (text proxy; sessions with text)  1234  1.0     2.0     3.0     -5.0  1000.0',
    )
    expect(lines[1]?.startsWith('session start -> first chunk')).toBe(true)
  })
})
