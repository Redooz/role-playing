import { join } from 'node:path'
import { formatViolation, validateTaskTree } from '@rp/eval-harness'
import { assertKnownFlags } from './cli-args.js'
import type { CliIo } from './cli-contract.js'

/**
 * The `validate-tasks` command (gate G3).
 *
 * Walks `evals/tasks` and `evals/golden` and prints every violation. Exit 0
 * means a clean tree; 1 means at least one violation.
 */
export async function validateTasksCommand(
  flags: Map<string, string>,
  repoRoot: string,
  io: CliIo,
): Promise<number> {
  assertKnownFlags(flags, ['repo-root'])

  const violations = await validateTaskTree(repoRoot)

  if (violations.length === 0) {
    io.out(`tasks: 0 violations under ${join(repoRoot, 'evals')}`)
    return 0
  }

  io.err(`tasks: ${violations.length} violation(s) under ${join(repoRoot, 'evals')}`)
  for (const violation of violations) io.err(`  ${formatViolation(violation)}`)
  return 1
}
