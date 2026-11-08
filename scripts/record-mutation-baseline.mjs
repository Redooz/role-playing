import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Record the measured mutation baseline (M1 D9 / gate M1-G6).
 *
 * Run this only after `npm run mutation` on a clean tree. It writes the per-file
 * and per-package scores that `scripts/check-mutation-floor.mjs` enforces.
 */

const root = resolve(new URL('..', import.meta.url).pathname)
const reportPath = join(root, 'reports', 'mutation', 'mutation.json')
const baselinePath = join(root, 'evals', 'baselines', 'm1-mutation.json')

const report = JSON.parse(await readFile(reportPath, 'utf8'))

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
        break
    }
  }

  const killedTotal = killed + timeout
  const total = killedTotal + survived + noCoverage
  const covered = killedTotal + survived

  return {
    mutants: mutants.length,
    killed,
    timeout,
    survived,
    noCoverage,
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

let commit = 'unknown'
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
} catch {
  // A baseline can still be recorded outside a git checkout.
}

const files = {}
const byPackage = {}
for (const [file, data] of Object.entries(report.files)) {
  const score = scoreOf(data.mutants ?? [])
  files[file] = score
  const packageName = packageOf(file)
  if (packageName === undefined) continue
  byPackage[packageName] ??= []
  byPackage[packageName].push(...(data.mutants ?? []))
}

const packages = {}
for (const [packageName, mutants] of Object.entries(byPackage)) {
  packages[packageName] = scoreOf(mutants)
}

const baseline = {
  schemaVersion: 1,
  suite: 'm1-mutation',
  generatedAt: new Date().toISOString(),
  commit,
  tool: '@stryker-mutator/core 10.1.1 + @stryker-mutator/vitest-runner 10.1.1',
  command: 'npm run mutation',
  note: 'Measured floor. Timed-out mutants count as killed; runtime/compile errors are excluded. Not a PR gate.',
  global: scoreOf(Object.values(report.files).flatMap((file) => file.mutants ?? [])),
  packages,
  files,
}

await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
console.log(`wrote ${baselinePath}`)
console.log(
  `global ${baseline.global.total}% total / ${baseline.global.covered}% covered at ${commit}`,
)
for (const [packageName, score] of Object.entries(packages)) {
  console.log(`  ${packageName}: ${score.total}% total / ${score.covered}% covered`)
}
