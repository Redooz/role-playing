import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  EvaluationObserver,
  ObservationPlan,
  ObserverConfig,
  ObserverFactory,
} from '@rp/eval-harness'
import { main, runExitCode, type CliIo } from './cli-main.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const manifestPath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')

const baseEnv: NodeJS.ProcessEnv = {
  LANGFUSE_ENABLED: 'true',
  LANGFUSE_BASE_URL: 'http://127.0.0.1:3000',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  LANGFUSE_PROJECT_ID: 'project-test',
}

const ENV_ENABLED = baseEnv
const ENV_DISABLED: NodeJS.ProcessEnv = { ...baseEnv, LANGFUSE_ENABLED: 'false' }

interface Capture {
  readonly io: CliIo
  readonly out: string[]
  readonly err: string[]
}

function captureIo(): Capture {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err }
}

function fakeObserver(received: ObservationPlan[] = []): ObserverFactory {
  return async (_config: ObserverConfig): Promise<EvaluationObserver> => ({
    async observe(plan) {
      received.push(plan)
      return {
        experimentId: plan.executionId,
        experimentUrl: `http://127.0.0.1:3000/project/project-test/experiments/${plan.executionId}`,
        traceIds: Object.fromEntries(
          plan.items.map((item) => [item.itemId, `trace-${item.itemId}`]),
        ),
      }
    },
    async shutdown() {},
  })
}

const roots: string[] = []

async function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  observerFactory?: ObserverFactory,
): Promise<{ code: number; io: Capture; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'rp-langfuse-'))
  roots.push(root)
  const io = captureIo()
  const code = await main(
    ['run', '--manifest', manifestPath, '--results-root', root, ...args],
    io.io,
    {
      repoRoot,
      wallClock: () => 1_700_000_000_000,
      env,
      ...(observerFactory === undefined ? {} : { observerFactory }),
    },
  )
  return { code, io, root }
}

async function readArtifact(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(root, 'm0-canned-replay', 'langfuse.json'), 'utf8'),
  ) as Record<string, unknown>
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('runExitCode', () => {
  it('reports a rejected verdict before an export failure', () => {
    expect(runExitCode('rejected', 'failed', true)).toBe(1)
    expect(runExitCode('inconclusive', 'failed', true)).toBe(1)
  })

  it('turns a failed required export into exit 3 only for an accepted run', () => {
    expect(runExitCode('accepted', 'failed', true)).toBe(3)
    expect(runExitCode('accepted', 'disabled', true)).toBe(3)
    expect(runExitCode('accepted', 'exported', true)).toBe(0)
    expect(runExitCode('accepted', 'failed', false)).toBe(0)
  })
})

describe('Langfuse export in the eval CLI', () => {
  it('writes grades.jsonl and a disabled langfuse.json when export is off', async () => {
    const { code, io, root } = await runCli([], ENV_DISABLED)
    expect(code).toBe(0)

    const gradesPath = join(root, 'm0-canned-replay', 'grades.jsonl')
    const grades = (await readFile(gradesPath, 'utf8')).trimEnd().split('\n')
    expect(grades).toHaveLength(12)

    const artifact = await readArtifact(root)
    expect(artifact['status']).toBe('disabled')
    expect(artifact['traceIds']).toEqual({})
    expect(io.out.join('\n')).toContain('langfuse: export disabled')

    // Export being off must not change the strict result artifact.
    const result = JSON.parse(
      await readFile(join(root, 'm0-canned-replay', 'result.json'), 'utf8'),
    ) as { verdict: { status: string } }
    expect(result.verdict.status).toBe('accepted')
  })

  it('--no-export wins over LANGFUSE_ENABLED=true', async () => {
    const { code, root } = await runCli(['--no-export'], ENV_ENABLED, fakeObserver())
    expect(code).toBe(0)
    expect((await readArtifact(root))['status']).toBe('disabled')
  })

  it('exports 12 item traces and records every trace id', async () => {
    const plans: ObservationPlan[] = []
    const { code, io, root } = await runCli([], ENV_ENABLED, fakeObserver(plans))

    expect(code).toBe(0)
    expect(plans).toHaveLength(1)
    const plan = plans[0]
    expect(plan?.items).toHaveLength(12)
    expect(plan?.experiment.id).toBe(plan?.executionId)
    expect(plan?.executionId).not.toBe('m0-canned-replay')

    const artifact = await readArtifact(root)
    expect(artifact['status']).toBe('exported')
    expect(artifact['experimentId']).toBe(plan?.executionId)
    expect(Object.keys(artifact['traceIds'] as Record<string, string>)).toHaveLength(12)
    expect(io.out.join('\n')).toContain('exported 12 item trace(s)')
  })

  it('keeps the verdict when the export fails', async () => {
    const failing: ObserverFactory = async () => {
      throw new Error('langfuse is unreachable')
    }
    const { code, io, root } = await runCli([], ENV_ENABLED, failing)

    expect(code).toBe(0)
    expect(io.err.join('\n')).toContain('langfuse: export failed')
    expect((await readArtifact(root))['status']).toBe('failed')

    const result = JSON.parse(
      await readFile(join(root, 'm0-canned-replay', 'result.json'), 'utf8'),
    ) as { verdict: { status: string } }
    expect(result.verdict.status).toBe('accepted')
  })

  it('exits 3 with --require-export after writing every artifact', async () => {
    const failing: ObserverFactory = async () => {
      throw new Error('langfuse is unreachable')
    }
    const { code, root } = await runCli(['--require-export'], ENV_ENABLED, failing)

    expect(code).toBe(3)
    expect((await readArtifact(root))['status']).toBe('failed')

    for (const file of ['result.json', 'grades.jsonl', 'manifest.json']) {
      const path = join(root, 'm0-canned-replay', file)
      await expect(stat(path)).resolves.toBeDefined()
    }
  })

  it('refuses Langfuse Cloud and writes a failed artifact', async () => {
    const { code, io, root } = await runCli(
      [],
      { ...ENV_ENABLED, LANGFUSE_BASE_URL: 'https://cloud.langfuse.com' },
      fakeObserver(),
    )

    expect(code).toBe(0)
    expect(io.err.join('\n')).toContain('self-hosted only')
    expect((await readArtifact(root))['status']).toBe('failed')
  })

  it('rejects --no-export combined with --require-export', async () => {
    const { code, io } = await runCli(
      ['--no-export', '--require-export'],
      ENV_ENABLED,
      fakeObserver(),
    )
    expect(code).toBe(2)
    expect(io.err.join('\n')).toContain('cannot be combined')
  })
})
