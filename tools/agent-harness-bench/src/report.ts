import { mkdir, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { MeasurementReport } from './measure.js'

/**
 * Report writer for the M0 harness-overhead benchmark (D7 / gate G5).
 *
 * Artifacts go under `evals/results/`, which is git-ignored. The report carries
 * enough environment detail (Node version, platform, CPU, iteration count,
 * timestamp) for a later run to be compared meaningfully. It deliberately
 * records measurements only: no latency budget is frozen at M0.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** Git-ignored path where the benchmark report is written. */
export const DEFAULT_REPORT_PATH = join(
  REPO_ROOT,
  'evals',
  'results',
  'm0-harness-overhead',
  'bench.json',
)

export interface HarnessReport {
  readonly schemaVersion: 1
  readonly suite: 'm0-harness-overhead'
  readonly note: 'M0 harness overhead only; no latency budget is frozen.'
  readonly budgetFrozen: false
  readonly generatedAt: string
  readonly node: string
  readonly platform: string
  readonly arch: string
  readonly cpuModel: string
  readonly cpuCount: number
  readonly iterations: number
  readonly workloads: readonly MeasurementReport[]
}

/** Build a traceable report from the per-workload measurement results. */
export function buildHarnessReport(
  workloads: readonly MeasurementReport[],
  iterations: number,
): HarnessReport {
  const processors = cpus()

  return {
    schemaVersion: 1,
    suite: 'm0-harness-overhead',
    note: 'M0 harness overhead only; no latency budget is frozen.',
    budgetFrozen: false,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: processors[0]?.model ?? 'unknown',
    cpuCount: processors.length,
    iterations,
    workloads,
  }
}

/** A written report plus the absolute path it was persisted to. */
export interface HarnessReportArtifact {
  readonly report: HarnessReport
  readonly path: string
}

/**
 * Write the report as pretty-printed JSON, creating parent directories as
 * needed. Returns both the report and the absolute path that was written so a
 * caller can print the measurements it just persisted.
 */
export async function writeHarnessReport(
  report: HarnessReport,
  filePath = DEFAULT_REPORT_PATH,
): Promise<HarnessReportArtifact> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return { report, path: filePath }
}
