import { resolve } from 'node:path'
import { HarnessConfigError, ManifestValidationError, formatManifestIssue } from '@rp/eval-harness'
import { BOOLEAN_FLAGS, parseOptions, printHelp } from './cli-args.js'
import { CliUsageError, errorMessage } from './cli-errors.js'
import type { CliDeps, CliIo } from './cli-contract.js'
import { defaultRepoRoot } from './cli-workspace.js'
import { compareCommand } from './compare-command.js'
import { exportRunCommand } from './export-run-command.js'
import { runCommand } from './run-command.js'
import { validateTasksCommand } from './validate-tasks-command.js'

export type { CliDeps, CliIo } from './cli-contract.js'
export { runExitCode } from './run-command.js'

/**
 * `eval-harness` CLI (M0 D3/D6).
 *
 * Exit codes are part of the contract:
 * - `run`:       0 accepted, 1 rejected/inconclusive, 2 invalid manifest/config
 * - `compare`:   0 every axis passes, 1 regression/inconclusive, 2 usage error
 * - `validate-tasks`: 0 zero violations, 1 any violation, 2 usage error
 *
 * Secrets are never read here. npm loads `.env` with `--env-file-if-exists`
 * before this process starts; the CLI does not hard-code or print credentials.
 */

const SYSTEM_IO: CliIo = {
  out(line) {
    process.stdout.write(`${line}\n`)
  },
  err(line) {
    process.stderr.write(`${line}\n`)
  },
}

export async function main(
  argv: readonly string[],
  io: CliIo = SYSTEM_IO,
  deps: CliDeps = {},
): Promise<number> {
  const args = [...argv]

  if (args.length === 0) {
    io.err('missing command')
    printHelp(io.err)
    return 2
  }

  if (args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    printHelp(io.out)
    return 0
  }

  const command = args[0]
  if (command === undefined) {
    io.err('missing command')
    return 2
  }

  let flags: Map<string, string>
  try {
    flags = parseOptions(args.slice(1), BOOLEAN_FLAGS)
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.err(error.message)
      io.err('run with --help for usage')
      return 2
    }
    throw error
  }

  try {
    const repoRoot = resolve(deps.repoRoot ?? flags.get('repo-root') ?? defaultRepoRoot())

    switch (command) {
      case 'run':
        return await runCommand(flags, repoRoot, io, deps)
      case 'export-run':
        return await exportRunCommand(flags, repoRoot, io, deps)
      case 'compare':
        return await compareCommand(flags, io)
      case 'validate-tasks':
        return await validateTasksCommand(flags, repoRoot, io)
      default:
        io.err(`unknown command "${command}"`)
        io.err('run with --help for usage')
        return 2
    }
  } catch (error) {
    if (error instanceof ManifestValidationError) {
      io.err('manifest rejected:')
      for (const issue of error.issues) io.err(`  ${formatManifestIssue(issue)}`)
      return 2
    }

    if (error instanceof HarnessConfigError) {
      io.err(`configuration error: ${error.message}`)
      for (const issue of error.issues) io.err(`  ${formatManifestIssue(issue)}`)
      return 2
    }

    if (error instanceof CliUsageError) {
      io.err(error.message)
      io.err('run with --help for usage')
      return 2
    }

    io.err(`error: ${errorMessage(error)}`)
    return 2
  }
}
