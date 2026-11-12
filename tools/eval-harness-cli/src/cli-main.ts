import { execFileSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson } from '@rp/shared'
import {
  ManifestValidationError,
  HarnessConfigError,
  M2_JEV_GRADER_ID,
  buildGrades,
  compareRunResults,
  createJevAxisGrader,
  createJevClient,
  createTurnTakingGrader,
  TURN_TAKING_GRADER_ID,
  deriveExecutionId,
  executeRun,
  formatManifestIssue,
  formatViolation,
  loadSelectedTasks,
  parseRunResult,
  runResultSchema,
  trialGradeSchema,
  validateTaskTree,
  validateManifest,
  type Grader,
  type GradesArtifact,
  type ObserverFactory,
  type ProviderFactory,
  type RunResult,
  type EvaluationRun,
  type TrialTranscriptFile,
} from '@rp/eval-harness'
import { normalizedTranscriptJsonl, parseTranscriptRecord } from '@rp/session-core'
import { createLiveProviderFactory } from './live-provider.js'
import { exportRun } from './export-run.js'
import { formatComparison, formatRunResult } from './output.js'

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

export interface CliIo {
  out(line: string): void
  err(line: string): void
}

export interface CliDeps {
  /** Override the repository root (tests). */
  repoRoot?: string
  /** Override wall-clock metadata (tests). */
  wallClock?: () => number
  /** Override the code SHA stamp (tests). */
  codeSha?: string
  /** Environment for the Langfuse export step (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Replace the Langfuse adapter in tests; never loaded unless export is on. */
  observerFactory?: ObserverFactory
  /** Override the provider factory (tests). */
  providerFactory?: ProviderFactory
  /** Override the semantic grader (tests). */
  grader?: Grader
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

const HELP_TEXT = `eval-harness - simulated-time evaluation harness (M0.1)

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
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['no-export', 'require-export', 'no-scores'])

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

async function runCommand(
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

/**
 * Re-export an existing run directory without re-running the model.
 *
 * The run artifacts already contain the result, normalized transcripts, grades
 * and task selection. This command rebuilds the in-memory `EvaluationRun`
 * shape the observer needs and calls the same export path as `run`.
 */
async function exportRunCommand(
  flags: Map<string, string>,
  repoRoot: string,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  assertKnownFlags(flags, ['run', 'repo-root', 'no-scores'])

  const runArg = flags.get('run')
  if (runArg === undefined) throw new CliUsageError('export-run requires --run <dir>')
  const runDir = resolve(runArg)
  if (!(await pathExists(runDir))) {
    throw new CliUsageError(`run directory not found: ${runDir}`)
  }

  const result = parseRunResult(await readJsonFile(join(runDir, 'result.json')))
  const tasks = await loadSelectedTasks(repoRoot, result.manifest.tasks)

  const transcripts: TrialTranscriptFile[] = []
  for (const artifact of result.transcripts) {
    const raw = await readFile(join(runDir, artifact.path), 'utf8')
    const records =
      raw.trim() === ''
        ? []
        : raw
            .trim()
            .split('\n')
            .map((line) => parseTranscriptRecord(JSON.parse(line)))
    transcripts.push({
      taskId: artifact.taskId,
      lang: artifact.lang,
      round: artifact.round,
      relativePath: artifact.path,
      jsonl: normalizedTranscriptJsonl(records),
      sha256: artifact.sha256,
      records,
    })
  }

  const gradesJsonl = await readFile(join(runDir, 'grades.jsonl'), 'utf8')
  const records =
    gradesJsonl.trim() === ''
      ? []
      : gradesJsonl
          .trim()
          .split('\n')
          .map((line) => trialGradeSchema.parse(JSON.parse(line)))
  if (records.length === 0) {
    throw new HarnessConfigError(
      `grades.jsonl in ${runDir} is empty; refusing to export a run without grades`,
    )
  }

  const executionId = records[0]?.executionId ?? deriveExecutionId(result.runId, result.startedAt)
  const execution: EvaluationRun = { result, transcripts, tasks, gradeDetails: [] }

  const artifact = await exportRun({
    execution,
    grades: { executionId, records, jsonl: gradesJsonl },
    runDir,
    repoRoot,
    io,
    env: deps.env ?? process.env,
    ...(deps.observerFactory === undefined ? {} : { observerFactory: deps.observerFactory }),
    noExport: false,
    requireExport: true,
    includeScores: flags.get('no-scores') !== 'true',
  })

  if (artifact.status === 'exported') return 0
  return artifact.status === 'failed' ? 3 : 2
}

async function compareCommand(flags: Map<string, string>, io: CliIo): Promise<number> {
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

async function validateTasksCommand(
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

async function writeRunArtifacts(
  runDir: string,
  execution: EvaluationRun,
  grades: GradesArtifact,
): Promise<void> {
  await mkdir(runDir, { recursive: true })

  await writeFile(
    join(runDir, 'manifest.json'),
    `${canonicalJson(execution.result.manifest)}\n`,
    'utf8',
  )
  await writeFile(join(runDir, 'manifest.sha256'), `${execution.result.manifestHash}\n`, 'utf8')

  for (const transcript of execution.transcripts) {
    const transcriptPath = join(runDir, transcript.relativePath)
    await mkdir(dirname(transcriptPath), { recursive: true })
    await writeFile(transcriptPath, transcript.jsonl, 'utf8')
  }

  await writeFile(
    join(runDir, 'result.json'),
    `${JSON.stringify(execution.result, null, 2)}\n`,
    'utf8',
  )
  await writeFile(join(runDir, 'grades.jsonl'), grades.jsonl, 'utf8')
}

async function readRunArtifact(path: string, label: string): Promise<RunResult> {
  const resolved = await resolveArtifactPath(path, label)
  const raw = await readJsonFile(resolved)
  const parsed = runResultSchema.safeParse(raw)

  if (!parsed.success) {
    throw new CliUsageError(
      `invalid ${label} artifact ${resolved}: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    )
  }

  return parsed.data
}

async function resolveArtifactPath(path: string, label: string): Promise<string> {
  let isDirectory: boolean
  try {
    isDirectory = (await stat(path)).isDirectory()
  } catch (error) {
    throw new CliUsageError(`cannot read ${label} artifact ${path}: ${errorMessage(error)}`)
  }

  return isDirectory ? join(path, 'result.json') : path
}

async function readJsonFile(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new CliUsageError(`cannot read ${path}: ${errorMessage(error)}`)
  }

  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new CliUsageError(`invalid JSON in ${path}: ${errorMessage(error)}`)
  }
}

function parseOptions(
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

function assertKnownFlags(flags: Map<string, string>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  for (const name of flags.keys()) {
    if (!allowedSet.has(name)) throw new CliUsageError(`unknown flag --${name}`)
  }
}

function printHelp(write: (line: string) => void): void {
  for (const line of HELP_TEXT.split('\n')) write(line)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
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

function resolveCodeSha(repoRoot: string): string | undefined {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return sha === '' ? undefined : sha
  } catch {
    return undefined
  }
}

function defaultRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..', '..')
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
