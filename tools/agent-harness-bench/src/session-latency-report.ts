import { mkdir, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PercentileSummary } from './percentiles.js'
import type { LatencyMeasurement, LatencySummary, TurnFailure } from './session-latency.js'

/**
 * Report writer for the M1 text latency baseline (D5 / gate M1-G4).
 *
 * Artifacts go under `evals/results/`, which is git-ignored. The report carries
 * the sample count for every axis and the environment it was measured on. It
 * freezes no budget: budgets are set only after measurements exist, and the
 * text proxy is labelled as a proxy because audio does not exist yet.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** Git-ignored path where the latency report is written. */
export const DEFAULT_TEXT_LATENCY_REPORT_PATH = join(
  REPO_ROOT,
  'evals',
  'results',
  'm1-text-latency',
  'latency.json',
)

export interface TextLatencyReport {
  readonly schemaVersion: 1
  readonly suite: 'm1-text-latency'
  readonly note: 'Wall-clock text proxy: session start -> first text chunk. No audio exists in M1. No latency budget is frozen.'
  readonly budgetFrozen: false
  readonly generatedAt: string
  readonly provider: 'groq'
  readonly model: 'openai/gpt-oss-20b'
  readonly label: 'text proxy'
  readonly sessions: number
  readonly turnsPerSession: number
  readonly throttleMs: number
  readonly turnsMeasured: number
  readonly failures: readonly TurnFailure[]
  readonly metrics: LatencySummary
  readonly environment: {
    readonly node: string
    readonly platform: string
    readonly arch: string
    readonly cpuModel: string
    readonly cpuCount: number
  }
}

export interface BuildTextLatencyReportOptions {
  readonly measurement: LatencyMeasurement
  readonly summary: LatencySummary
  readonly sessions: number
  readonly turnsPerSession: number
  readonly throttleMs: number
}

export function buildTextLatencyReport(options: BuildTextLatencyReportOptions): TextLatencyReport {
  const processors = cpus()

  return {
    schemaVersion: 1,
    suite: 'm1-text-latency',
    note: 'Wall-clock text proxy: session start -> first text chunk. No audio exists in M1. No latency budget is frozen.',
    budgetFrozen: false,
    generatedAt: new Date().toISOString(),
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
    label: 'text proxy',
    sessions: options.sessions,
    turnsPerSession: options.turnsPerSession,
    throttleMs: options.throttleMs,
    turnsMeasured: options.measurement.turns.length,
    failures: options.measurement.failures,
    metrics: options.summary,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuModel: processors[0]?.model ?? 'unknown',
      cpuCount: processors.length,
    },
  }
}

export interface TextLatencyReportArtifact {
  readonly report: TextLatencyReport
  readonly path: string
}

export async function writeTextLatencyReport(
  report: TextLatencyReport,
  filePath = DEFAULT_TEXT_LATENCY_REPORT_PATH,
): Promise<TextLatencyReportArtifact> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return { report, path: filePath }
}

/** Human-readable table: no mean-only reporting; every axis carries its n. */
export function formatLatencyTable(report: TextLatencyReport): string[] {
  const rows: string[][] = [
    ['metric', 'n', 'p50 ms', 'p95 ms', 'p99 ms', 'min', 'max'],
    summaryRow(
      'session start -> first chunk (text proxy)',
      report.metrics.sessionStartToFirstChunkMs,
    ),
    summaryRow('turn utterance -> first chunk (TTFT)', report.metrics.turnTtftMs),
    summaryRow('turn utterance -> committed (total)', report.metrics.turnTotalMs),
  ]

  if (report.metrics.providerTtftMs !== undefined) {
    rows.push(summaryRow('provider request -> first content', report.metrics.providerTtftMs))
  }
  if (report.metrics.localOverheadMs !== undefined) {
    rows.push(summaryRow('local overhead (driver + event loop)', report.metrics.localOverheadMs))
  }

  const widths = [0, 1, 2, 3, 4, 5, 6].map((index) =>
    Math.max(...rows.map((row) => (row[index] ?? '').length)),
  )

  return rows.map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  '))
}

function summaryRow(label: string, summary: PercentileSummary): string[] {
  return [
    label,
    String(summary.count),
    summary.p50.toFixed(1),
    summary.p95.toFixed(1),
    summary.p99.toFixed(1),
    summary.min.toFixed(1),
    summary.max.toFixed(1),
  ]
}
