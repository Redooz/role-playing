/**
 * Pure scoring and comparison for the per-package mutation floor (M1 D9 / M1-G6).
 *
 * Kept separate from the CLI entry point so the gate logic can be tested with
 * fixture reports. A missing report, a missing package, a malformed entry or a
 * package with no scorable mutants is a **failure**, never a silent 100%.
 */

export function scoreMutants(mutants) {
  let killed = 0
  let timeout = 0
  let survived = 0
  let noCoverage = 0
  let ignored = 0
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
      case 'Ignored':
        ignored += 1
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
    ignored,
    errors,
    scored,
    total: scored === 0 ? null : (killedTotal / scored) * 100,
    covered: covered === 0 ? null : (killedTotal / covered) * 100,
  }
}

/**
 * Map a report path to its workspace package. Generic on purpose: a package
 * added to the mutation scope must not fall outside the per-package floor just
 * because it is not one of the three names known today.
 */
export function packageOf(file) {
  const match = /^(packages|apps|tools)\/([^/]+)\//.exec(file)
  if (match === null) return undefined
  return `${match[1]}/${match[2]}`
}

function percent(value) {
  if (value === null || value === undefined) return 'n/a'
  return Number(value).toFixed(2)
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

  // Validate before scoring: a malformed entry must fail the gate, not quietly
  // remove its mutants from a package score.
  const validated = []
  for (const [file, data] of Object.entries(reportFiles)) {
    if (data === null || typeof data !== 'object' || !Array.isArray(data.mutants)) {
      failures.push(`mutation report entry "${file}" has no mutants array`)
      continue
    }

    const mutants = []
    for (const [index, mutant] of data.mutants.entries()) {
      if (mutant === null || typeof mutant !== 'object' || typeof mutant.status !== 'string') {
        failures.push(`mutation report entry "${file}" mutant ${index} is malformed`)
        continue
      }
      mutants.push(mutant)
    }
    validated.push([file, mutants])
  }

  const allMutants = validated.flatMap(([, mutants]) => mutants)
  const global = scoreMutants(allMutants)

  if (allMutants.length === 0) {
    failures.push('mutation report contains no mutants')
  } else if (global.total === null || global.covered === null) {
    failures.push('mutation report contains no scorable mutants')
  } else {
    if (global.total < baseline.global.total) {
      failures.push(
        `global total ${percent(global.total)}% < floor ${percent(baseline.global.total)}%`,
      )
    }
    if (global.covered < baseline.global.covered) {
      failures.push(
        `global covered ${percent(global.covered)}% < floor ${percent(baseline.global.covered)}%`,
      )
    }
  }

  const byPackage = {}
  for (const [file, mutants] of validated) {
    const packageName = packageOf(file)
    if (packageName === undefined) {
      failures.push(
        `mutation report entry "${file}" does not belong to packages/<name>/, apps/<name>/ or tools/<name>/`,
      )
      continue
    }
    byPackage[packageName] ??= []
    byPackage[packageName].push(...mutants)
  }

  const baselinePackages = baseline.packages ?? {}
  for (const packageName of Object.keys(byPackage)) {
    if (!Object.hasOwn(baselinePackages, packageName)) {
      failures.push(
        `${packageName} has mutants but no baseline floor; add it to evals/baselines/m1-mutation.json`,
      )
    }
  }

  const packages = {}
  for (const [packageName, floor] of Object.entries(baselinePackages)) {
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
      failures.push(
        `${packageName} total ${percent(actual.total)}% < floor ${percent(floor.total)}%`,
      )
    }
    if (actual.covered < floor.covered) {
      failures.push(
        `${packageName} covered ${percent(actual.covered)}% < floor ${percent(floor.covered)}%`,
      )
    }
  }

  return { global, packages, failures }
}
