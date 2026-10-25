import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main, type CliIo } from './cli-main.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const cliPath = join(here, 'cli.ts')
const manifestPath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')
const incompleteManifestPath = join(repoRoot, 'evals/manifests/m0-incomplete-missing-limits.json')

/** Every manifest section the runner requires (gate G2). */
const REQUIRED_SECTIONS = [
  'run',
  'fixtures',
  'seeds',
  'scorer',
  'rubric',
  'limits',
  'target',
  'guardrails',
  'invariants',
  'provider',
] as const

interface ProcessResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
    out,
    err,
  }
}

function execCli(args: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: process.env,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: unknown) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk: unknown) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
  })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function traceFiles(root: string): Promise<string[]> {
  return (await readdir(join(root, 'm0-canned-replay', 'traces'), { recursive: true }))
    .filter((entry) => entry.endsWith('.jsonl'))
    .sort()
}

let firstRoot = ''
let secondRoot = ''
let regressedRoot = ''

beforeAll(async () => {
  firstRoot = await mkdtemp(join(tmpdir(), 'rp-eval-cli-a-'))
  secondRoot = await mkdtemp(join(tmpdir(), 'rp-eval-cli-b-'))
  regressedRoot = await mkdtemp(join(tmpdir(), 'rp-eval-cli-regressed-'))

  const first = await execCli(['run', '--manifest', manifestPath, '--results-root', firstRoot])
  expect(first.code).toBe(0)
  expect(first.stdout).toContain('verdict: accepted')

  const second = await execCli(['run', '--manifest', manifestPath, '--results-root', secondRoot])
  expect(second.code).toBe(0)
})

afterAll(async () => {
  for (const root of [firstRoot, secondRoot, regressedRoot]) {
    if (root !== '') await rm(root, { recursive: true, force: true })
  }
})

describe('eval-runner CLI', () => {
  it('prints usage for --help', async () => {
    const result = await execCli(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage:')
    expect(result.stdout).toContain('validate-fixtures')
  })

  it('validates the committed fixture tree with zero violations (G3)', async () => {
    const result = await execCli(['validate-fixtures'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('0 violations')
    expect(result.stderr).toBe('')
  })

  it('writes the manifest copy, hash, result and normalized traces', async () => {
    const runDir = join(firstRoot, 'm0-canned-replay')
    expect(await pathExists(join(runDir, 'manifest.json'))).toBe(true)
    expect(await pathExists(join(runDir, 'manifest.sha256'))).toBe(true)

    const result = JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8')) as {
      verdict: { status: string }
      metrics: Record<string, number>
    }
    expect(result.verdict.status).toBe('accepted')
    expect(Object.keys(result.metrics)).toContain('replay.deterministic_rate')

    const files = await traceFiles(firstRoot)
    expect(files).toHaveLength(12)
    expect(files.some((file) => file.startsWith('rep-0/en/'))).toBe(true)
    expect(files.some((file) => file.startsWith('rep-0/fr/'))).toBe(true)
  })

  it('produces byte-identical traces across two CLI runs (G1)', async () => {
    const first = await traceFiles(firstRoot)
    const second = await traceFiles(secondRoot)

    expect(second).toEqual(first)

    for (const relativePath of first) {
      const firstTrace = await readFile(
        join(firstRoot, 'm0-canned-replay', 'traces', relativePath),
        'utf8',
      )
      const secondTrace = await readFile(
        join(secondRoot, 'm0-canned-replay', 'traces', relativePath),
        'utf8',
      )
      expect(secondTrace, relativePath).toBe(firstTrace)
    }
  })

  it('refuses an incomplete manifest with an explicit error and executes nothing (G2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rp-eval-cli-bad-'))

    try {
      const result = await execCli([
        'run',
        '--manifest',
        incompleteManifestPath,
        '--results-root',
        root,
      ])

      expect(result.code).toBe(2)
      expect(result.stderr).toContain('manifest rejected')
      expect(result.stderr).toContain('limits')
      expect(result.stderr).toContain('missing required field')
      expect(result.stderr).toContain('nothing was executed')
      expect(await pathExists(join(root, 'm0-incomplete-example'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(REQUIRED_SECTIONS)(
    'refuses a manifest without the %s section before executing (G2)',
    async (section) => {
      const root = await mkdtemp(join(tmpdir(), 'rp-eval-cli-g2-'))

      try {
        const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
        const run = raw['run'] as Record<string, unknown> | undefined
        const runId = typeof run?.['runId'] === 'string' ? run['runId'] : 'missing-run'
        delete raw[section]

        const manifestFile = join(root, 'manifest.json')
        await writeFile(manifestFile, JSON.stringify(raw), 'utf8')

        const capture = captureIo()
        const code = await main(
          ['run', '--manifest', manifestFile, '--results-root', join(root, 'results')],
          capture.io,
          { repoRoot },
        )

        expect(code).toBe(2)
        expect(capture.err.join('\n')).toContain(`${section}: missing required field`)
        expect(capture.out).toEqual([])
        expect(await pathExists(join(root, 'results', runId))).toBe(false)
        expect(await pathExists(join(root, 'results'))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('compares a run against an accepted baseline and exits 0', async () => {
    const baseline = join(firstRoot, 'm0-canned-replay', 'result.json')
    const candidate = join(secondRoot, 'm0-canned-replay')

    const result = await execCli(['compare', '--baseline', baseline, '--run', candidate])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('comparison: PASS')
    expect(result.stdout).toContain('target replay.deterministic_rate')
  })

  it('exits 1 when a guardrail regresses', async () => {
    const baseline = join(firstRoot, 'm0-canned-replay', 'result.json')
    const candidateResult = JSON.parse(
      await readFile(join(secondRoot, 'm0-canned-replay', 'result.json'), 'utf8'),
    ) as { metrics: Record<string, number> }

    candidateResult.metrics['trace.guard_violations'] = 2
    await writeFile(
      join(regressedRoot, 'result.json'),
      `${JSON.stringify(candidateResult, null, 2)}\n`,
      'utf8',
    )

    const result = await execCli(['compare', '--baseline', baseline, '--run', regressedRoot])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('comparison: FAIL')
    expect(result.stdout).toContain('trace.guard_violations')
  })

  it('rejects a compare invocation missing --run as a usage error', async () => {
    const result = await execCli(['compare', '--baseline', 'whatever.json'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--run')
  })

  it('refuses an unknown command', async () => {
    const result = await execCli(['frobnicate'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unknown command')
  })
})
