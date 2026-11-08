/**
 * Pure scoring and comparison for the per-package mutation floor (M1 D9 / M1-G6).
 *
 * Kept separate from the CLI entry point so the gate logic can be tested with
 * fixture reports. A missing report, a missing package or a package with no
 * scorable mutants is a **failure**, never a silent 100%.
 */

export function scoreMutants(mutants) {
  let killed = 0
  let timeout = 0
  let survived = 0
  let noCoverage = 0
  let errors = 0

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
        errors += 1
        break
    }
  }

  const killedTotal = killed + timeout
  const scored = killedTotal + survived + noCoverage
  const covered = killedTotal + survived

  return {
    mutants: mutants.length,
    killed,
    timeout,
    survived,
    noCoverage,
    errors,
    scored,
    total: scored === 0 ? null : Number(((killedTotal / scored) * 100).toFixed(2)),
    covered: covered === 0 ? null : Number(((killedTotal / covered) * 100).toFixed(2)),
  }
}

export function packageOf(file) {
  if (file.startsWith('packages/session-core/')) return 'packages/session-core'
  if (file.startsWith('packages/pipeline/')) return 'packages/pipeline'
  if (file.startsWith('apps/cli/')) return 'apps/cli'
  return undefined
}

/**
 * Compare a Stryker JSON report with the frozen baseline.
 *
 * Returns the global and per-package scores plus every reason the floor was
 * violated. `global` is `undefined` when the report had no files at all.
 */
export function evaluateMutationFloor(report, baseline) {
  const failures = []
  const reportFiles =
    report !== null && typeof report === 'object' && typeof report.files === 'object'
      ? report.files
      : undefined

  if (reportFiles === undefined || reportFiles === null || Object.keys(reportFiles).length === 0) {
    return {
      global: undefined,
      packages: {},
      failures: ['mutation report contains no files'],
    }
  }

  const allMutants = Object.values(reportFiles).flatMap((file) =>
    Array.isArray(file?.mutants) ? file.mutants : [],
  )
  const global = scoreMutants(allMutants)

  if (allMutants.length === 0) {
    failures.push('mutation report contains no mutants')
  } else if (global.total === null || global.covered === null) {
    failures.push('mutation report contains no scorable mutants')
  } else {
    if (global.total < baseline.global.total) {
      failures.push(`global total ${global.total}% < floor ${baseline.global.total}%`)
    }
    if (global.covered < baseline.global.covered) {
      failures.push(`global covered ${global.covered}% < floor ${baseline.global.covered}%`)
    }
  }

  const byPackage = {}
  for (const [file, data] of Object.entries(reportFiles)) {
    const packageName = packageOf(file)
    if (packageName === undefined) continue
    byPackage[packageName] ??= []
    byPackage[packageName].push(...(Array.isArray(data?.mutants) ? data.mutants : []))
  }

  const packages = {}
  for (const [packageName, floor] of Object.entries(baseline.packages ?? {})) {
    const mutants = byPackage[packageName]
    if (mutants === undefined || mutants.length === 0) {
      failures.push(`${packageName} has no mutants in the report`)
      continue
    }

    const actual = scoreMutants(mutants)
    packages[packageName] = actual

    if (actual.total === null || actual.covered === null) {
      failures.push(`${packageName} has no scorable mutants`)
      continue
    }
    if (actual.total < floor.total) {
      failures.push(`${packageName} total ${actual.total}% < floor ${floor.total}%`)
    }
    if (actual.covered < floor.covered) {
      failures.push(`${packageName} covered ${actual.covered}% < floor ${floor.covered}%`)
    }
  }

  return { global, packages, failures }
}
