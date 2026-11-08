import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateMutationFloor } from './mutation-floor.mjs'

/**
 * Per-package mutation floor (M1 D9 / gate M1-G6).
 *
 * Stryker's own `thresholds.break` is a single global number. The plan requires
 * a floor per package, so this script recomputes each package's score from the
 * JSON report and compares it with the committed baseline. Timed-out mutants
 * count as killed; runtime/compile errors are excluded, as in Stryker's score.
 *
 * Exit 1 on any regression, on an empty report, or on a package missing from
 * the report. The run is on-demand/scheduled, not a PR gate.
 */

const root = resolve(new URL('..', import.meta.url).pathname)
const reportPath = join(root, 'reports', 'mutation', 'mutation.json')
const baselinePath = join(root, 'evals', 'baselines', 'm1-mutation.json')

export async function main() {
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
  const { global, packages, failures } = evaluateMutationFloor(report, baseline)

  if (failures.length > 0) {
    console.error('mutation floor violated:')
    for (const failure of failures) console.error(`- ${failure}`)
    process.exit(1)
  }

  console.log(`mutation floor held: global ${global.total}% total / ${global.covered}% covered`)
  for (const [packageName, floor] of Object.entries(baseline.packages)) {
    const actual = packages[packageName]
    console.log(
      `  ${packageName}: ${actual.total}% total / ${actual.covered}% covered ` +
        `(floor ${floor.total}/${floor.covered})`,
    )
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
