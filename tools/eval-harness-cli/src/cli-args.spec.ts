import { describe, expect, it } from 'vitest'
import { BOOLEAN_FLAGS, HELP_TEXT, assertKnownFlags, parseOptions, printHelp } from './cli-args.js'
import { CliUsageError } from './cli-errors.js'

/**
 * `cli-args` owns flag parsing and the usage text. These tests pin the exact
 * usage error messages and the exact help text, because both are part of the
 * CLI's user-visible contract (a caller sees only the text, not an error code).
 */

const HELP_LINES = [
  'eval-harness - simulated-time evaluation harness (M0.1)',
  '',
  'Usage:',
  '  eval-harness run --manifest <path> [--results-root <dir>] [--repo-root <dir>]',
  '                   [--no-export] [--require-export]',
  '  eval-harness export-run --run <dir> [--repo-root <dir>] [--no-scores]',
  '  eval-harness compare --baseline <path> --run <dir-or-result.json> [--repo-root <dir>]',
  '  eval-harness validate-tasks [--repo-root <dir>]',
  '  eval-harness --help',
  '',
  'Commands:',
  '  run                 Validate a pre-registered manifest, execute its rounds,',
  '                      write the manifest copy + hash, result.json, grades.jsonl',
  '                      and normalized transcripts, then export the run to the',
  '                      self-hosted Langfuse review layer when enabled.',
  '                      Exit 0 accepted, 1 rejected/inconclusive, 2 invalid manifest',
  '                      or configuration, 3 export required but failed (artifacts',
  '                      are still written).',
  '  export-run          Re-export an existing run directory to Langfuse without',
  '                      re-running the model. Requires the self-hosted Langfuse',
  '                      configuration. --no-scores omits automated scores for',
  '                      blind human labelling. Exit 0 exported, 2 usage/config',
  '                      error, 3 export failed.',
  '  compare             Compare a committed baseline artifact with a run directory.',
  '                      Exit 0 all axes pass, 1 regression/inconclusive, 2 usage error.',
  '  validate-tasks      Validate evals/tasks and evals/golden (gate G3).',
  '                      Exit 0 zero violations, 1 any violation.',
  '',
  'Notes:',
  '  - The manifest is pre-registered and validated before anything executes.',
  '  - Provider/output failures are never turned into a "no" or a zero.',
  '  - Results default to evals/results/<runId>/ (git-ignored); --results-root',
  '    redirects them, which is how tests stay read-only.',
  '  - No composite score is printed; every axis and guardrail is shown separately.',
  '  - Langfuse export is opt-in via LANGFUSE_ENABLED=true. --no-export forces it',
  '    off; --require-export makes a failed export exit non-zero after artifacts',
  '    are written. Export never changes the verdict.',
]

function usageError(run: () => unknown): CliUsageError {
  try {
    run()
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error
    return error
  }
  throw new Error('expected a CliUsageError')
}

describe('HELP_TEXT', () => {
  it('documents every command, flag and exit code exactly', () => {
    expect(HELP_TEXT.split('\n')).toStrictEqual(HELP_LINES)
  })
})

describe('BOOLEAN_FLAGS', () => {
  it('contains exactly the flags that take no value', () => {
    expect([...BOOLEAN_FLAGS].sort()).toStrictEqual(['no-export', 'no-scores', 'require-export'])
  })
})

describe('parseOptions', () => {
  it('returns an empty map for an empty argument list', () => {
    expect(parseOptions([])).toStrictEqual(new Map())
  })

  it('skips a hole in the argument array instead of reading it as a flag', () => {
    // Defensive guard: `noUncheckedIndexedAccess` makes the index a
    // `string | undefined`; a sparse array exercises that branch.
    const sparse = new Array<string>(2)

    expect(parseOptions(sparse)).toStrictEqual(new Map())
  })

  it('reads a separated value and keeps later flags', () => {
    expect(parseOptions(['--manifest', 'evals/manifests/m0.json', '--result', 'x'])).toStrictEqual(
      new Map([
        ['manifest', 'evals/manifests/m0.json'],
        ['result', 'x'],
      ]),
    )
  })

  it('reads an = value and keeps any further = characters in the value', () => {
    expect(parseOptions(['--a=b=c'])).toStrictEqual(new Map([['a', 'b=c']]))
  })

  it('accepts a value that starts with a single dash', () => {
    expect(parseOptions(['--run', '-']).get('run')).toBe('-')
  })

  it.each([
    ['--manifest', 'flag --manifest requires a value'],
    ['--results-root', 'flag --results-root requires a value'],
  ])('rejects %s without a value', (flag, message) => {
    const error = usageError(() => parseOptions([flag]))

    expect(error.message).toBe(message)
  })

  it('rejects an = form with an empty value', () => {
    const error = usageError(() => parseOptions(['--manifest=']))

    expect(error.message).toBe('flag --manifest requires a value')
  })

  it('rejects a flag followed by another flag as a missing value', () => {
    const error = usageError(() => parseOptions(['--manifest', '--results-root', 'out']))

    expect(error.message).toBe('flag --manifest requires a value')
  })

  it('rejects a bare -- as an empty flag name', () => {
    const error = usageError(() => parseOptions(['--', 'value']))

    expect(error.message).toBe('empty flag name')
  })

  it('does not split on an = at index 2, so --=x is a nameless token', () => {
    const error = usageError(() => parseOptions(['--=x']))

    expect(error.message).toBe('flag --=x requires a value')
  })

  it('rejects a positional argument', () => {
    const error = usageError(() => parseOptions(['evals/results']))

    expect(error.message).toBe('unexpected argument "evals/results"')
  })

  it('rejects a short flag, which the parser does not support', () => {
    const error = usageError(() => parseOptions(['-h']))

    expect(error.message).toBe('unexpected argument "-h"')
  })

  it('stores a declared boolean flag as "true" and takes no value', () => {
    expect(parseOptions(['--no-export', '--manifest', 'm.json'], BOOLEAN_FLAGS)).toStrictEqual(
      new Map([
        ['no-export', 'true'],
        ['manifest', 'm.json'],
      ]),
    )
  })

  it('treats an undeclared flag with the same name as a value flag', () => {
    const error = usageError(() => parseOptions(['--no-export'], new Set()))

    expect(error.message).toBe('flag --no-export requires a value')
  })

  it('lets the = form carry an explicit value for a boolean flag', () => {
    expect(parseOptions(['--no-export=false'], BOOLEAN_FLAGS)).toStrictEqual(
      new Map([['no-export', 'false']]),
    )
  })

  it('rejects a repeated flag, including a repeated boolean flag', () => {
    expect(usageError(() => parseOptions(['--a', '1', '--a', '2'])).message).toBe(
      'flag --a was provided more than once',
    )
    expect(usageError(() => parseOptions(['--a=1', '--a', '2'])).message).toBe(
      'flag --a was provided more than once',
    )
    expect(
      usageError(() => parseOptions(['--no-export', '--no-export'], BOOLEAN_FLAGS)).message,
    ).toBe('flag --no-export was provided more than once')
  })
})

describe('assertKnownFlags', () => {
  it('accepts every flag in the allow list', () => {
    const flags = new Map([
      ['manifest', 'm.json'],
      ['repo-root', '/tmp/repo'],
    ])

    expect(() => assertKnownFlags(flags, ['manifest', 'repo-root'])).not.toThrow()
  })

  it('accepts an empty map', () => {
    expect(() => assertKnownFlags(new Map(), ['manifest'])).not.toThrow()
  })

  it('rejects the first flag that is not allowed and names it', () => {
    const flags = new Map([
      ['scores', 'all'],
      ['manifest', 'm.json'],
    ])

    expect(usageError(() => assertKnownFlags(flags, ['manifest'])).message).toBe(
      'unknown flag --scores',
    )
  })
})

describe('printHelp', () => {
  it('writes every help line in order to the given sink', () => {
    const written: string[] = []

    printHelp((line) => written.push(line))

    expect(written).toStrictEqual(HELP_LINES)
  })
})
