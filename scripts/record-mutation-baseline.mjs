import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBaselineRegressions, packageOf, scoreMutants } from './mutation-floor.mjs'

/**
 * Record the measured mutation baseline (M1 D9 / gate M1-G6).
 *
 * Run this only after `npm run mutation` on a clean tree. It writes the per-file
 * and per-package scores that `scripts/check-mutation-floor.mjs` enforces, and
 * refuses to record a baseline with nothing to measure.
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const reportPath = join(root, 'reports', 'mutation', 'mutation.json')
const baselinePath = join(root, 'evals', 'baselines', 'm1-mutation.json')

const report = JSON.parse(await readFile(reportPath, 'utf8'))

const allMutants = Object.values(report.files ?? {}).flatMap((file) => file.mutants ?? [])
const global = scoreMutants(allMutants)
if (global.total === null || global.covered === null) {
  console.error('refusing to record a mutation baseline with no scorable mutants')
  process.exit(1)
}

function baselineScore(score) {
  const { mutants, killed, timeout, survived, noCoverage, ignored, errors, total, covered } = score
  return { mutants, killed, timeout, survived, noCoverage, ignored, errors, total, covered }
}

let commit = 'unknown'
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
} catch {
  // A baseline can still be recorded outside a git checkout.
}

const files = {}
const byPackage = {}
for (const [file, data] of Object.entries(report.files ?? {})) {
  const score = scoreMutants(data.mutants ?? [])
  files[file] = baselineScore(score)

  const packageName = packageOf(file)
  if (packageName === undefined) continue
  byPackage[packageName] ??= []
  byPackage[packageName].push(...(data.mutants ?? []))
}

const packages = {}
for (const [packageName, mutants] of Object.entries(byPackage)) {
  const score = scoreMutants(mutants)
  if (score.total === null || score.covered === null) {
    console.error(`refusing to record an empty floor for ${packageName}`)
    process.exit(1)
  }
  packages[packageName] = baselineScore(score)
}

const baseline = {
  schemaVersion: 1,
  suite: 'm1-mutation',
  generatedAt: new Date().toISOString(),
  commit,
  tool: '@stryker-mutator/core 10.1.1 + @stryker-mutator/vitest-runner 10.1.1',
  command: 'npm run mutation',
  note: 'Measured floor. Timed-out mutants count as killed; runtime/compile errors are excluded. Not a PR gate.',
  global: baselineScore(global),
  packages,
  files,
}

let previous
try {
  previous = JSON.parse(await readFile(baselinePath, 'utf8'))
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
}

const regressions = findBaselineRegressions(previous, baseline)
if (regressions.length > 0) {
  console.error('refusing to record a baseline that lowers an existing floor:')
  for (const regression of regressions) console.error(`- ${regression}`)
  process.exit(1)
}

await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
console.log(`wrote ${baselinePath}`)
console.log(
  `global ${baseline.global.total.toFixed(2)}% total / ${baseline.global.covered.toFixed(2)}% covered at ${commit}`,
)
for (const [packageName, score] of Object.entries(packages)) {
  console.log(
    `  ${packageName}: ${score.total.toFixed(2)}% total / ${score.covered.toFixed(2)}% covered`,
  )
}
