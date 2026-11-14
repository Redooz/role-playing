import { execFileSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson } from '@rp/shared'
import { runResultSchema, type GradesArtifact, type RunResult } from '@rp/eval-harness'
import { errorMessage, CliUsageError } from './cli-errors.js'
import type { EvaluationRun } from '@rp/eval-harness'

/**
 * Local workspace access for the eval-harness CLI.
 *
 * Locates the repository root, stamps its code SHA, and reads/writes the JSON
 * artifacts a run produces. Path and parse failures are `CliUsageError`s; no
 * command reads the environment here.
 */

export function defaultRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..', '..')
}

export function resolveCodeSha(repoRoot: string): string | undefined {
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

export async function readJsonFile(path: string): Promise<unknown> {
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

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

export async function writeRunArtifacts(
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

export async function readRunArtifact(path: string, label: string): Promise<RunResult> {
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

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
