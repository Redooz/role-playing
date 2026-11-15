import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvaluationRun, GradesArtifact, RunResult } from '@rp/eval-harness'
import { canonicalJson } from '@rp/shared'
import { CliUsageError } from './cli-errors.js'
import {
  defaultRepoRoot,
  pathExists,
  readJsonFile,
  readRunArtifact,
  resolveCodeSha,
  writeRunArtifacts,
} from './cli-workspace.js'

const here = dirname(fileURLToPath(import.meta.url))

const git = vi.hoisted(() => ({
  execFileSync: vi.fn<(command: string, args: readonly string[], options: object) => string>(),
}))

vi.mock('node:child_process', () => git)

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eval-cli-workspace-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('defaultRepoRoot', () => {
  it('resolves three levels above the CLI source directory', async () => {
    const root = defaultRepoRoot()

    expect(root).toBe(resolve(here, '..', '..', '..'))
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      name?: string
    }
    expect(packageJson.name).toBe('role-playing')
  })
})

describe('resolveCodeSha', () => {
  it('returns the trimmed HEAD sha from git', () => {
    git.execFileSync.mockReturnValue('  0123abc  \n')

    expect(resolveCodeSha('/some/repo')).toBe('0123abc')
  })

  it('reads HEAD from the requested repository with stderr suppressed', () => {
    git.execFileSync.mockReturnValue('abc\n')

    resolveCodeSha('/some/repo')

    expect(git.execFileSync).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], {
      cwd: '/some/repo',
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  })

  it('treats empty git output as an unavailable sha', () => {
    git.execFileSync.mockReturnValue('  \n')

    expect(resolveCodeSha('/some/repo')).toBeUndefined()
  })

  it('treats an unavailable git command as an unavailable sha', () => {
    git.execFileSync.mockImplementation(() => {
      throw new Error('fatal: not a git repository')
    })

    expect(resolveCodeSha('/some/repo')).toBeUndefined()
  })
})

describe('readJsonFile', () => {
  it('parses an object, an array and a scalar', async () => {
    const dir = await tempDir()
    const objectPath = join(dir, 'object.json')
    const arrayPath = join(dir, 'array.json')
    const scalarPath = join(dir, 'scalar.json')
    await writeFile(objectPath, '{"a":1}', 'utf8')
    await writeFile(arrayPath, '[1,2]', 'utf8')
    await writeFile(scalarPath, '"text"', 'utf8')

    await expect(readJsonFile(objectPath)).resolves.toStrictEqual({ a: 1 })
    await expect(readJsonFile(arrayPath)).resolves.toStrictEqual([1, 2])
    await expect(readJsonFile(scalarPath)).resolves.toBe('text')
  })

  it('reports a missing file as a usage error that names the path', async () => {
    const dir = await tempDir()
    const missing = join(dir, 'missing.json')

    const error = await readJsonFile(missing).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(CliUsageError)
    expect((error as Error).name).toBe('CliUsageError')
    expect((error as Error).message.startsWith(`cannot read ${missing}: `)).toBe(true)
    expect((error as Error).message).toContain('ENOENT')
  })

  it('reports malformed JSON as a usage error that names the path', async () => {
    const dir = await tempDir()
    const badPath = join(dir, 'bad.json')
    await writeFile(badPath, '{"a":', 'utf8')

    const error = await readJsonFile(badPath).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(CliUsageError)
    expect((error as Error).message.startsWith(`invalid JSON in ${badPath}: `)).toBe(true)
  })
})

describe('pathExists', () => {
  it('is true for a file and for a directory', async () => {
    const dir = await tempDir()
    const file = join(dir, 'file.txt')
    await writeFile(file, 'x', 'utf8')

    await expect(pathExists(file)).resolves.toBe(true)
    await expect(pathExists(dir)).resolves.toBe(true)
  })

  it('is false only when the path is missing', async () => {
    const dir = await tempDir()

    await expect(pathExists(join(dir, 'missing'))).resolves.toBe(false)
  })

  it('rethrows an error that is not a missing path', async () => {
    const dir = await tempDir()
    const file = join(dir, 'file.txt')
    await writeFile(file, 'x', 'utf8')

    await expect(pathExists(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('writeRunArtifacts', () => {
  const manifest = { run: { runId: 'artifact-run', purpose: 'capability' }, tasks: { version: 1 } }
  const result = { manifest, manifestHash: 'sha-256-value' }

  function execution(): EvaluationRun {
    return {
      result,
      transcripts: [
        { relativePath: 'transcripts/round-1/en/greeting-standup.jsonl', jsonl: '{"n":1}\n' },
        { relativePath: 'nested/deeper/other.jsonl', jsonl: 'two\n' },
      ],
    } as unknown as EvaluationRun
  }

  it('writes the manifest, hash, transcripts, result and grades exactly', async () => {
    const dir = await tempDir()
    const runDir = join(dir, 'results', 'artifact-run')
    const grades = { jsonl: '{"metric":"persona.semantic_match"}\n' } as GradesArtifact

    await writeRunArtifacts(runDir, execution(), grades)

    await expect(readFile(join(runDir, 'manifest.json'), 'utf8')).resolves.toBe(
      `${canonicalJson(manifest)}\n`,
    )
    await expect(readFile(join(runDir, 'manifest.sha256'), 'utf8')).resolves.toBe('sha-256-value\n')
    await expect(
      readFile(join(runDir, 'transcripts/round-1/en/greeting-standup.jsonl'), 'utf8'),
    ).resolves.toBe('{"n":1}\n')
    await expect(readFile(join(runDir, 'nested/deeper/other.jsonl'), 'utf8')).resolves.toBe('two\n')
    await expect(readFile(join(runDir, 'result.json'), 'utf8')).resolves.toBe(
      `${JSON.stringify(result, null, 2)}\n`,
    )
    await expect(readFile(join(runDir, 'grades.jsonl'), 'utf8')).resolves.toBe(grades.jsonl)
  })

  it('reuses an existing run directory', async () => {
    const dir = await tempDir()
    const runDir = join(dir, 'artifact-run')
    await mkdir(runDir)
    await writeFile(join(runDir, 'stale.txt'), 'stale', 'utf8')

    await writeRunArtifacts(runDir, execution(), { jsonl: '' } as GradesArtifact)

    await expect(readFile(join(runDir, 'grades.jsonl'), 'utf8')).resolves.toBe('')
    await expect(stat(join(runDir, 'manifest.json'))).resolves.toBeDefined()
  })
})

describe('readRunArtifact', () => {
  const baselinePath = resolve(here, '..', '..', '..', 'evals/baselines/m0-canned-replay.json')

  async function baseline(): Promise<RunResult> {
    return JSON.parse(await readFile(baselinePath, 'utf8')) as RunResult
  }

  it('reads result.json from a run directory', async () => {
    const dir = await tempDir()
    const runDir = join(dir, 'm0-canned-replay')
    await mkdir(runDir)
    const expected = await baseline()
    await writeFile(join(runDir, 'result.json'), JSON.stringify(expected), 'utf8')

    await expect(readRunArtifact(runDir, 'baseline')).resolves.toStrictEqual(expected)
  })

  it('reads a result file given directly', async () => {
    const dir = await tempDir()
    const file = join(dir, 'result.json')
    const expected = await baseline()
    await writeFile(file, JSON.stringify(expected), 'utf8')

    await expect(readRunArtifact(file, 'run')).resolves.toStrictEqual(expected)
  })

  it('reports a missing artifact with its label and path', async () => {
    const dir = await tempDir()
    const missing = join(dir, 'missing')

    const error = await readRunArtifact(missing, 'baseline').catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(CliUsageError)
    expect((error as Error).message.startsWith(`cannot read baseline artifact ${missing}: `)).toBe(
      true,
    )
  })

  it('reports malformed JSON at the resolved path', async () => {
    const dir = await tempDir()
    const file = join(dir, 'result.json')
    await writeFile(file, 'not json', 'utf8')

    const error = await readRunArtifact(file, 'run').catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(CliUsageError)
    expect((error as Error).message.startsWith(`invalid JSON in ${file}: `)).toBe(true)
  })

  it('names the root path when the artifact is not an object', async () => {
    const dir = await tempDir()
    const file = join(dir, 'result.json')
    await writeFile(file, '[]', 'utf8')

    const error = await readRunArtifact(file, 'run').catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(CliUsageError)
    expect((error as Error).message).toBe(
      `invalid run artifact ${file}: <root>: Invalid input: expected object, received array`,
    )
  })

  it('reports every schema issue with its path and message', async () => {
    const dir = await tempDir()
    const file = join(dir, 'result.json')
    const invalid = await baseline()
    await writeFile(
      file,
      JSON.stringify({ ...invalid, manifestHash: 7, summary: { attempts: 'two' } }),
      'utf8',
    )

    const error = await readRunArtifact(file, 'run').catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(CliUsageError)
    const message = (error as Error).message
    expect(message.startsWith(`invalid run artifact ${file}: `)).toBe(true)
    expect(message).toContain('manifestHash: ')
    expect(message).toContain('summary.attempts: ')
    expect(message).toContain('; ')
  })
})
