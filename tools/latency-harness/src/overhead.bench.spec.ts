import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { measureAsync, measureSync, type MeasurementReport } from './measure.js'
import { buildHarnessReport, writeHarnessReport, type HarnessReport } from './report.js'
import {
  createEventSerializationWorkload,
  createFakeClockDispatchWorkload,
  createTraceAppendWorkload,
  type AsyncWorkload,
  type SyncWorkload,
} from './workloads.js'

/**
 * M0 harness-overhead benchmark (D7 / gate G5).
 *
 * This file only runs under the `bench` Vitest project (`*.bench.spec.ts`); the
 * unit project excludes it, so the PR gate never pays for wall-time work.
 *
 * Wall-clock timing is correct here because this is a benchmark, not engine
 * code. The simulated-time rule applies to replay inside the engine. At M0 the
 * harness measures its own overhead — fake-clock dispatch, event serialization,
 * and trace append — and records it. **No latency budget is frozen at M0.**
 */

const DEFAULT_ITERATIONS = 500

function resolveIterations(): number {
  const raw = process.env.BENCH_ITERATIONS
  if (raw === undefined || raw.trim() === '') return DEFAULT_ITERATIONS

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new RangeError(`BENCH_ITERATIONS must be a positive integer, received: ${raw}`)
  }
  return parsed
}

const ITERATIONS = resolveIterations()

function measureSyncWorkload(workload: SyncWorkload): MeasurementReport {
  return measureSync(workload.name, ITERATIONS, workload.run, {
    beforeEach: workload.beforeEach,
  })
}

async function measureAsyncWorkload(workload: AsyncWorkload): Promise<MeasurementReport> {
  return measureAsync(workload.name, ITERATIONS, workload.run, {
    beforeEach: workload.beforeEach,
  })
}

function formatMicros(milliseconds: number): string {
  return (milliseconds * 1_000).toFixed(2)
}

function printTable(report: HarnessReport): void {
  const columns = ['workload', 'p50 µs', 'p95 µs', 'p99 µs', 'mean µs', 'min µs', 'max µs']
  const rows = report.workloads.map((workload) => [
    workload.workload,
    formatMicros(workload.percentiles.p50),
    formatMicros(workload.percentiles.p95),
    formatMicros(workload.percentiles.p99),
    formatMicros(workload.percentiles.mean),
    formatMicros(workload.percentiles.min),
    formatMicros(workload.percentiles.max),
  ])

  const widths = columns.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => row[index]?.length ?? 0)),
  )
  const formatRow = (row: readonly string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ')

  const warmup = report.workloads[0]?.warmupIterations ?? 0
  console.log(
    `\nM0 harness overhead — ${report.iterations} measured iterations (+${warmup} warmup) per workload`,
  )
  console.log(formatRow(columns))
  for (const row of rows) console.log(formatRow(row))
  console.log(`${report.node} · ${report.platform}/${report.arch} · ${report.cpuModel}`)
}

describe('M0 harness overhead', () => {
  it(
    'measures dispatch, serialization, and trace append, then writes the report',
    { timeout: 30_000 },
    async () => {
      const workloads: MeasurementReport[] = [
        await measureAsyncWorkload(createFakeClockDispatchWorkload()),
        measureSyncWorkload(createEventSerializationWorkload()),
        measureSyncWorkload(createTraceAppendWorkload()),
      ]

      const report = buildHarnessReport(workloads, ITERATIONS)
      const written = await writeHarnessReport(report)

      printTable(written.report)
      console.log(`Report: ${written.path}\n`)

      expect(report.workloads.map((workload) => workload.workload)).toEqual([
        'fake-clock dispatch',
        'event serialization',
        'trace append',
      ])
      expect(report.workloads.every((workload) => workload.iterations === ITERATIONS)).toBe(true)
      expect(report.budgetFrozen).toBe(false)

      const persisted = JSON.parse(await readFile(written.path, 'utf8')) as HarnessReport
      expect(persisted.suite).toBe('m0-harness-overhead')
      expect(persisted.workloads).toHaveLength(3)
    },
  )
})
