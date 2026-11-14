import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  HarnessConfigError,
  deriveExecutionId,
  loadSelectedTasks,
  parseRunResult,
  trialGradeSchema,
  type EvaluationRun,
  type TrialTranscriptFile,
} from '@rp/eval-harness'
import { normalizedTranscriptJsonl, parseTranscriptRecord } from '@rp/session-core'
import { assertKnownFlags } from './cli-args.js'
import { CliUsageError } from './cli-errors.js'
import type { CliDeps, CliIo } from './cli-contract.js'
import { pathExists, readJsonFile } from './cli-workspace.js'
import { exportRun } from './export-run.js'

/**
 * The `export-run` command.
 *
 * Re-exports an existing run directory without re-running the model. The run
 * artifacts already contain the result, normalized transcripts, grades and task
 * selection; this command rebuilds the in-memory `EvaluationRun` shape the
 * observer needs and calls the same export path as `run`.
 */
export async function exportRunCommand(
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
