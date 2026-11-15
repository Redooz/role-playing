import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { isAbsolute, join, sep } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MeasurementReport } from './measure.js'
import {
  DEFAULT_REPORT_PATH,
  buildHarnessReport,
  writeHarnessReport,
  type HarnessReport,
} from './report.js'

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

function measurement(workload: string): MeasurementReport {
  return {
    workload,
    iterations: 3,
    warmupIterations: 0,
    totalMs: 6,
    durationsMs: [1, 2, 3],
    percentiles: {
      count: 3,
      min: 1,
      max: 3,
      mean: 2,
      p50: 2,
      p95: 2.9,
      p99: 2.98,
    },
  }
}

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rp-report-'))
  tempDirs.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('DEFAULT_REPORT_PATH', () => {
  it('points at the git-ignored M0 harness-overhead results directory', () => {
    expect(isAbsolute(DEFAULT_REPORT_PATH)).toBe(true)
    expect(
      DEFAULT_REPORT_PATH.endsWith(join('evals', 'results', 'm0-harness-overhead', 'bench.json')),
    ).toBe(true)
    expect(DEFAULT_REPORT_PATH.split(sep)).not.toContain('..')
  })
})

describe('buildHarnessReport', () => {
  it('builds the exact report with the environment and a fixed timestamp', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-14T12:34:56.789Z'))
    cpuState.processors = [{ model: 'Test CPU @ 1.00GHz' }, { model: 'Second CPU' }]
    const workloads = [measurement('alpha'), measurement('beta')]

    const report = buildHarnessReport(workloads, 500)

    expect(report).toStrictEqual({
      schemaVersion: 1,
      suite: 'm0-harness-overhead',
      note: 'M0 harness overhead only; no latency budget is frozen.',
      budgetFrozen: false,
      generatedAt: '2026-11-14T12:34:56.789Z',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuModel: 'Test CPU @ 1.00GHz',
      cpuCount: 2,
      iterations: 500,
      workloads,
    })
    expect(report.workloads).toBe(workloads)
  })

  it('records an empty workload list and falls back to unknown without CPUs', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-02T03:04:05.006Z'))

    const report = buildHarnessReport([], 1)

    expect(report.workloads).toStrictEqual([])
    expect(report.cpuModel).toBe('unknown')
    expect(report.cpuCount).toBe(0)
    expect(report.generatedAt).toBe('2026-01-02T03:04:05.006Z')
    expect(report.iterations).toBe(1)
  })
})

describe('writeHarnessReport', () => {
  it('creates parent directories and writes the exact pretty-printed JSON', async () => {
    cpuState.processors = [{ model: 'Test CPU' }]
    const report = buildHarnessReport([measurement('alpha')], 3)
    const filePath = join(await tempDir(), 'nested', 'deeper', 'bench.json')

    const artifact = await writeHarnessReport(report, filePath)

    expect(artifact.report).toBe(report)
    expect(artifact.path).toBe(filePath)
    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).toBe(`${JSON.stringify(report, null, 2)}\n`)
    const parsed = JSON.parse(persisted) as HarnessReport
    expect(parsed).toStrictEqual(report)
  })
})
