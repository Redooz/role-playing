import { describe, expect, it } from 'vitest'
import { evaluateMutationFloor, packageOf, scoreMutants } from './mutation-floor.mjs'

interface Mutant {
  status: string
}

function mutant(status: string): Mutant {
  return { status }
}

function report(files: Record<string, { mutants: Mutant[] }>) {
  return { files }
}

const baseline = {
  global: { total: 50, covered: 50 },
  packages: {
    'packages/session-core': { total: 50, covered: 50 },
  },
}

describe('scoreMutants', () => {
  it('counts timeouts as killed and excludes runtime errors from both scores', () => {
    const score = scoreMutants([
      mutant('Killed'),
      mutant('Timeout'),
      mutant('Survived'),
      mutant('NoCoverage'),
      mutant('RuntimeError'),
    ])

    expect(score).toMatchObject({
      mutants: 5,
      killed: 1,
      timeout: 1,
      survived: 1,
      noCoverage: 1,
      errors: 1,
      scored: 4,
      total: 50,
      covered: 66.67,
    })
  })

  it('returns null scores for an empty or unscorable set', () => {
    expect(scoreMutants([])).toMatchObject({ total: null, covered: null })
    expect(scoreMutants([mutant('RuntimeError')])).toMatchObject({ total: null, covered: null })
  })
})

describe('packageOf', () => {
  it('maps report paths to their package', () => {
    expect(packageOf('packages/session-core/src/driver.ts')).toBe('packages/session-core')
    expect(packageOf('packages/pipeline/src/groq-text.adapter.ts')).toBe('packages/pipeline')
    expect(packageOf('apps/cli/src/main.ts')).toBe('apps/cli')
    expect(packageOf('tools/other/file.ts')).toBeUndefined()
  })
})

describe('evaluateMutationFloor', () => {
  it('fails when the report has no files instead of scoring 100%', () => {
    const result = evaluateMutationFloor({ files: {} }, baseline)

    expect(result.global).toBeUndefined()
    expect(result.failures).toContain('mutation report contains no files')
  })

  it('fails when every mutant is a runtime error', () => {
    const result = evaluateMutationFloor(
      report({ 'packages/session-core/src/driver.ts': { mutants: [mutant('RuntimeError')] } }),
      baseline,
    )

    expect(result.failures).toContain('mutation report contains no scorable mutants')
  })

  it('fails when a baseline package is missing from the report', () => {
    const result = evaluateMutationFloor(
      report({ 'packages/pipeline/src/groq-text.adapter.ts': { mutants: [mutant('Killed')] } }),
      baseline,
    )

    expect(result.failures).toContain('packages/session-core has no mutants in the report')
  })

  it('fails when a package is present but has no mutants', () => {
    const result = evaluateMutationFloor(
      report({ 'packages/session-core/src/driver.ts': { mutants: [] } }),
      baseline,
    )

    expect(result.failures).toContain('packages/session-core has no mutants in the report')
  })

  it('passes exactly at the floor', () => {
    const result = evaluateMutationFloor(
      report({
        'packages/session-core/src/driver.ts': {
          mutants: [mutant('Killed'), mutant('Survived')],
        },
      }),
      baseline,
    )

    expect(result.failures).toEqual([])
    expect(result.global?.total).toBe(50)
    expect(result.packages['packages/session-core']?.total).toBe(50)
  })

  it('fails below the floor', () => {
    const result = evaluateMutationFloor(
      report({
        'packages/session-core/src/driver.ts': {
          mutants: [mutant('Killed'), mutant('Survived'), mutant('Survived')],
        },
      }),
      baseline,
    )

    expect(result.failures).toContain('packages/session-core total 33.33% < floor 50%')
    expect(result.failures).toContain('global total 33.33% < floor 50%')
  })
})
