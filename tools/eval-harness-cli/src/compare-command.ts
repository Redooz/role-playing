import { resolve } from 'node:path'
import { compareRunResults } from '@rp/eval-harness'
import { assertKnownFlags } from './cli-args.js'
import { CliUsageError } from './cli-errors.js'
import type { CliIo } from './cli-contract.js'
import { readRunArtifact } from './cli-workspace.js'
import { formatComparison } from './output.js'

/**
 * The `compare` command.
 *
 * Compares a committed, accepted baseline artifact with a run directory and
 * prints every axis separately. Exit 0 means every axis passed; 1 means a
 * regression or an inconclusive candidate; 2 is a usage error.
 */
export async function compareCommand(flags: Map<string, string>, io: CliIo): Promise<number> {
  assertKnownFlags(flags, ['baseline', 'run', 'repo-root'])

  const baselineArg = flags.get('baseline')
  if (baselineArg === undefined) throw new CliUsageError('compare requires --baseline <path>')
  const runArg = flags.get('run')
  if (runArg === undefined) throw new CliUsageError('compare requires --run <dir-or-result.json>')

  const baseline = await readRunArtifact(resolve(baselineArg), 'baseline')
  const candidate = await readRunArtifact(resolve(runArg), 'run')

  if (baseline.verdict.status !== 'accepted') {
    throw new CliUsageError(
      `baseline ${baseline.runId} has verdict "${baseline.verdict.status}"; only an accepted result may be used as a baseline`,
    )
  }

  if (candidate.verdict.status !== 'accepted') {
    io.out('comparison: FAIL (candidate not accepted)')
    io.out(
      `  - candidate ${candidate.runId} has verdict "${candidate.verdict.status}"; only an accepted candidate may be compared`,
    )
    return 1
  }

  const comparison = compareRunResults(baseline, candidate)
  for (const line of formatComparison(comparison)) io.out(line)

  return comparison.ok ? 0 : 1
}
