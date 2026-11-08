import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Per-package mutation floor (M1 D9 / gate M1-G6).
 *
 * Stryker's own `thresholds.break` is a single global number. The plan requires
 * a floor per package, so this script recomputes each package's score from the
 * JSON report and compares it with the committed baseline. Timed-out mutants
 * count as killed; runtime/compile errors are excluded, as in Stryker's score.
 *
 * Exit 1 on any regression. The run is on-demand/scheduled, not a PR gate.
 */

const root = resolve(new URL('..', import.meta.url).pathname)
const reportPath = join(root, 'reports', 'mutation', 'mutation.json')
const baselinePath = join(root, 'evals', 'baselines', 'm1-mutation.json')

const report = JSON.parse(await readFile(reportPath, 'utf8'))
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'))

function scoreOf(mutants) {
  let killed = 0
  let timeout = 0
  let survived = 0
  let noCoverage = 0

  for (const mutant of mutants) {
    switch (mutant.status) {
      case 'Killed':
        killed += 1
        break
      case 'Timeout':
        timeout += 1
        break
      case 'Survived':
        survived += 1
        break
      case 'NoCoverage':
        noCoverage += 1
        break
      default:
        // RuntimeError/CompileError are excluded from both scores.
        break
    }
  }

  const killedTotal = killed + timeout
  const total = killedTotal + survived + noCoverage
  const covered = killedTotal + survived

  return {
    total: total === 0 ? 100 : Number(((killedTotal / total) * 100).toFixed(2)),
    covered: covered === 0 ? 100 : Number(((killedTotal / covered) * 100).toFixed(2)),
  }
}

function packageOf(file) {
  if (file.startsWith('packages/session-core/')) return 'packages/session-core'
  if (file.startsWith('packages/pipeline/')) return 'packages/pipeline'
  if (file.startsWith('apps/cli/')) return 'apps/cli'
  return undefined
}

const allMutants = Object.values(report.files).flatMap((file) => file.mutants ?? [])
const global = scoreOf(allMutants)
const byPackage = {}

for (const [file, data] of Object.entries(report.files)) {
  const packageName = packageOf(file)
  if (packageName === undefined) continue
  byPackage[packageName] ??= []
  byPackage[packageName].push(...(data.mutants ?? []))
}

const failures = []
if (global.total < baseline.global.total) {
  failures.push(`global total ${global.total}% < floor ${baseline.global.total}%`)
}
if (global.covered < baseline.global.covered) {
  failures.push(`global covered ${global.covered}% < floor ${baseline.global.covered}%`)
}

for (const [packageName, floor] of Object.entries(baseline.packages)) {
  const actual = scoreOf(byPackage[packageName] ?? [])
  if (actual.total < floor.total) {
    failures.push(`${packageName} total ${actual.total}% < floor ${floor.total}%`)
  }
  if (actual.covered < floor.covered) {
    failures.push(`${packageName} covered ${actual.covered}% < floor ${floor.covered}%`)
  }
}

if (failures.length > 0) {
  console.error('mutation floor violated:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`mutation floor held: global ${global.total}% total / ${global.covered}% covered`)
for (const [packageName, floor] of Object.entries(baseline.packages)) {
  const actual = scoreOf(byPackage[packageName] ?? [])
  console.log(
    `  ${packageName}: ${actual.total}% total / ${actual.covered}% covered ` +
      `(floor ${floor.total}/${floor.covered})`,
  )
}
