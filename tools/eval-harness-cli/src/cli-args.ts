import { CliUsageError } from './cli-errors.js'

/**
 * Flag parsing and usage text for the eval-harness CLI.
 *
 * Pure argument handling: it never reads the environment or the filesystem, and
 * every malformed invocation becomes a `CliUsageError` for `main` to map to
 * exit code 2.
 */

export const HELP_TEXT = `eval-harness - simulated-time evaluation harness (M0.1)

Usage:
  eval-harness run --manifest <path> [--results-root <dir>] [--repo-root <dir>]
                   [--no-export] [--require-export]
  eval-harness export-run --run <dir> [--repo-root <dir>] [--no-scores]
  eval-harness compare --baseline <path> --run <dir-or-result.json> [--repo-root <dir>]
  eval-harness validate-tasks [--repo-root <dir>]
  eval-harness --help

Commands:
  run                 Validate a pre-registered manifest, execute its rounds,
                      write the manifest copy + hash, result.json, grades.jsonl
                      and normalized transcripts, then export the run to the
                      self-hosted Langfuse review layer when enabled.
                      Exit 0 accepted, 1 rejected/inconclusive, 2 invalid manifest
                      or configuration, 3 export required but failed (artifacts
                      are still written).
  export-run          Re-export an existing run directory to Langfuse without
                      re-running the model. Requires the self-hosted Langfuse
                      configuration. --no-scores omits automated scores for
                      blind human labelling. Exit 0 exported, 2 usage/config
                      error, 3 export failed.
  compare             Compare a committed baseline artifact with a run directory.
                      Exit 0 all axes pass, 1 regression/inconclusive, 2 usage error.
  validate-tasks      Validate evals/tasks and evals/golden (gate G3).
                      Exit 0 zero violations, 1 any violation.

Notes:
  - The manifest is pre-registered and validated before anything executes.
  - Provider/output failures are never turned into a "no" or a zero.
  - Results default to evals/results/<runId>/ (git-ignored); --results-root
    redirects them, which is how tests stay read-only.
  - No composite score is printed; every axis and guardrail is shown separately.
  - Langfuse export is opt-in via LANGFUSE_ENABLED=true. --no-export forces it
    off; --require-export makes a failed export exit non-zero after artifacts
    are written. Export never changes the verdict.`

/** Flags that take no value; they are stored as `"true"`. */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'no-export',
  'require-export',
  'no-scores',
])

export function parseOptions(
  args: readonly string[],
  booleanFlags: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const flags = new Map<string, string>()

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === undefined) continue

    if (!token.startsWith('--')) {
      throw new CliUsageError(`unexpected argument "${token}"`)
    }

    const equals = token.indexOf('=')
    if (equals > 2) {
      const name = token.slice(2, equals)
      const value = token.slice(equals + 1)
      if (value === '') throw new CliUsageError(`flag --${name} requires a value`)
      setFlag(flags, name, value)
      continue
    }

    const name = token.slice(2)
    if (booleanFlags.has(name)) {
      setFlag(flags, name, 'true')
      continue
    }

    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new CliUsageError(`flag --${name} requires a value`)
    }

    setFlag(flags, name, value)
    index += 1
  }

  return flags
}

function setFlag(flags: Map<string, string>, name: string, value: string): void {
  if (name === '') throw new CliUsageError('empty flag name')
  if (flags.has(name)) throw new CliUsageError(`flag --${name} was provided more than once`)
  flags.set(name, value)
}

export function assertKnownFlags(flags: Map<string, string>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  for (const name of flags.keys()) {
    if (!allowedSet.has(name)) throw new CliUsageError(`unknown flag --${name}`)
  }
}

export function printHelp(write: (line: string) => void): void {
  for (const line of HELP_TEXT.split('\n')) write(line)
}
