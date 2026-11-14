import { join, resolve } from 'node:path'
import {
  HarnessConfigError,
  M2_JEV_GRADER_ID,
  TURN_TAKING_GRADER_ID,
  buildGrades,
  createJevAxisGrader,
  createJevClient,
  createTurnTakingGrader,
  executeRun,
  formatManifestIssue,
  validateManifest,
  type Grader,
  type RunResult,
} from '@rp/eval-harness'
import { assertKnownFlags } from './cli-args.js'
import { CliUsageError } from './cli-errors.js'
import type { CliDeps, CliIo } from './cli-contract.js'
import { pathExists, readJsonFile, resolveCodeSha, writeRunArtifacts } from './cli-workspace.js'
import { exportRun } from './export-run.js'
import { createLiveProviderFactory } from './live-provider.js'
import { formatRunResult } from './output.js'

/**
 * The `run` command.
 *
 * Validates the pre-registered manifest, executes its rounds, writes the run
 * directory, prints every axis separately and then exports to the review layer
 * when enabled. The exit code is the eval verdict's, never the export's.
 */

export async function runCommand(
  flags: Map<string, string>,
  repoRoot: string,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  assertKnownFlags(flags, ['manifest', 'results-root', 'repo-root', 'no-export', 'require-export'])

  const noExport = flags.get('no-export') === 'true'
  const requireExport = flags.get('require-export') === 'true'
  if (noExport && requireExport) {
    throw new CliUsageError('--no-export and --require-export cannot be combined')
  }

  const manifestArg = flags.get('manifest')
  if (manifestArg === undefined) throw new CliUsageError('run requires --manifest <path>')

  const manifestPath = resolve(manifestArg)
  const raw = await readJsonFile(manifestPath)
  const validation = validateManifest(raw)

  if (!validation.ok) {
    io.err(`manifest rejected (${manifestPath}):`)
    for (const issue of validation.issues) io.err(`  ${formatManifestIssue(issue)}`)
    io.err(`nothing was executed; ${validation.issues.length} manifest field(s) need attention`)
    return 2
  }

  const manifest = validation.manifest
  const resultsRootArg = flags.get('results-root')
  const resultsRoot =
    resultsRootArg === undefined ? join(repoRoot, 'evals', 'results') : resolve(resultsRootArg)
  const runDir = join(resultsRoot, manifest.run.runId)

  if (await pathExists(runDir)) {
    throw new HarnessConfigError(
      `results directory already exists: ${runDir}; refusing to overwrite a previous run`,
    )
  }

  const env = deps.env ?? process.env
  const providerFactory =
    deps.providerFactory ??
    (manifest.provider.mode === 'live'
      ? createLiveProviderFactory({
          label: manifest.provider.label,
          env,
          paceMs: manifest.provider.paceMs ?? 0,
        })
      : undefined)
  const grader =
    deps.grader ??
    (manifest.grader.id === M2_JEV_GRADER_ID
      ? createJevGrader(env)
      : manifest.grader.id === TURN_TAKING_GRADER_ID
        ? createTurnTakingGrader()
        : undefined)

  const execution = await executeRun({
    repoRoot,
    manifest,
    wallClock: deps.wallClock,
    codeSha: deps.codeSha ?? resolveCodeSha(repoRoot),
    ...(providerFactory === undefined ? {} : { providerFactory }),
    ...(grader === undefined ? {} : { grader }),
  })

  if (execution.result.manifestHash !== validation.manifestHash) {
    throw new HarnessConfigError(
      'the manifest changed between validation and execution; refusing to persist a mismatched result',
    )
  }

  const grades = buildGrades({ execution })
  await writeRunArtifacts(runDir, execution, grades)

  for (const line of formatRunResult(execution.result)) io.out(line)
  io.out('')
  io.out(`results: ${runDir}`)

  const artifact = await exportRun({
    execution,
    grades,
    runDir,
    repoRoot,
    io,
    env: deps.env ?? process.env,
    ...(deps.observerFactory === undefined ? {} : { observerFactory: deps.observerFactory }),
    noExport,
    requireExport,
  })

  return runExitCode(execution.result.verdict.status, artifact.status, requireExport)
}

/**
 * Exit-code precedence: the eval verdict always wins. A rejected or
 * inconclusive run reports that decision even when the export also failed;
 * only an accepted run can turn an export failure into exit 3.
 */
export function runExitCode(
  verdict: RunResult['verdict']['status'],
  exportStatus: 'disabled' | 'exported' | 'failed',
  requireExport: boolean,
): number {
  const verdictCode = verdict === 'accepted' ? 0 : 1
  if (verdictCode !== 0) return verdictCode
  return requireExport && exportStatus !== 'exported' ? 3 : 0
}

/** Jev grader for the persona axes. Pinned to `typesafe/jev-1.14`. */
function createJevGrader(env: NodeJS.ProcessEnv): Grader {
  const apiKey = env['OPENROUTER_API_KEY']
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new HarnessConfigError(
      'a Jev-graded run requires OPENROUTER_API_KEY (set it in .env or the environment)',
    )
  }
  return createJevAxisGrader({ client: createJevClient({ apiKey }) })
}
