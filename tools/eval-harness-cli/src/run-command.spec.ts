import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvaluationObserver, Grader, ObservationPlan } from '@rp/eval-harness'
import { createDeterministicInvariantGrader } from '@rp/eval-harness'
import { main, type CliIo } from './cli-main.js'
import { runExitCode } from './run-command.js'

/**
 * The `run` command is the composition root of the eval CLI: it validates the
 * pre-registered manifest, refuses to overwrite a previous run, selects the
 * provider and grader from the manifest, and stamps the exit code from the
 * verdict. A live provider or a semantic grader is never built here in tests;
 * the missing-credential paths are asserted instead.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const manifestPath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')
const incompleteManifestPath = join(repoRoot, 'evals/manifests/m0-incomplete-missing-limits.json')

const DISABLED_ENV: NodeJS.ProcessEnv = { LANGFUSE_ENABLED: 'false' }

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

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eval-cli-run-'))
  tempDirs.push(dir)
  return dir
}

async function readManifest(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
}

/** Write a copy of the M0 manifest with the given top-level sections replaced. */
async function writeManifest(dir: string, overrides: Record<string, unknown>): Promise<string> {
  const manifest = { ...(await readManifest()), ...overrides }
  const path = join(dir, 'manifest.json')
  await writeFile(path, JSON.stringify(manifest), 'utf8')
  return path
}

async function invoke(
  args: readonly string[],
  deps: Record<string, unknown> = {},
): Promise<{ code: number } & Capture> {
  const capture = captureIo()
  const code = await main(args, capture.io, { repoRoot, env: DISABLED_ENV, ...deps })
  return { code, ...capture }
}

function throwingGrader(message: string): Grader {
  return {
    id: 'deterministic-invariants',
    kind: 'code',
    version: '1.0.0',
    async score() {
      throw new Error(message)
    },
  }
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
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

describe('run command argument handling', () => {
  it('rejects an unknown flag as a usage error', async () => {
    const { code, err, out } = await invoke(['run', '--scores', 'all'])

    expect(code).toBe(2)
    expect(out).toStrictEqual([])
    expect(err).toStrictEqual(['unknown flag --scores', 'run with --help for usage'])
  })

  it('requires --manifest', async () => {
    const { code, err } = await invoke(['run'])

    expect(code).toBe(2)
    expect(err).toStrictEqual(['run requires --manifest <path>', 'run with --help for usage'])
  })

  it('rejects --no-export combined with --require-export', async () => {
    const { code, err } = await invoke([
      'run',
      '--manifest',
      manifestPath,
      '--no-export',
      '--require-export',
    ])

    expect(code).toBe(2)
    expect(err).toStrictEqual([
      '--no-export and --require-export cannot be combined',
      'run with --help for usage',
    ])
  })
})

describe('run command manifest validation', () => {
  it('prints every issue, executes nothing and exits 2 for an incomplete manifest', async () => {
    const root = await tempDir()
    const { code, err, out } = await invoke([
      'run',
      '--manifest',
      incompleteManifestPath,
      '--results-root',
      root,
    ])

    expect(code).toBe(2)
    expect(out).toStrictEqual([])
    expect(err).toStrictEqual([
      `manifest rejected (${incompleteManifestPath}):`,
      '  limits: missing required field',
      'nothing was executed; 1 manifest field(s) need attention',
    ])
    await expect(readFile(join(root, 'm0-incomplete-example'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('run command results root', () => {
  it('refuses to overwrite an existing run under the default results root', async () => {
    const root = await tempDir()
    const existing = join(root, 'evals', 'results', 'm0-canned-replay')
    await mkdir(existing, { recursive: true })

    const { code, err, out } = await invoke(['run', '--manifest', manifestPath], { repoRoot: root })

    expect(code).toBe(2)
    expect(out).toStrictEqual([])
    expect(err).toStrictEqual([
      `configuration error: results directory already exists: ${existing}; refusing to overwrite a previous run`,
    ])
  })

  it('accepts the shared --repo-root flag', async () => {
    const root = await tempDir()
    const existing = join(root, 'evals', 'results', 'm0-canned-replay')
    await mkdir(existing, { recursive: true })

    const { code, err } = await invoke(['run', '--manifest', manifestPath, '--repo-root', root], {
      repoRoot: root,
    })

    expect(code).toBe(2)
    expect(err).toStrictEqual([
      `configuration error: results directory already exists: ${existing}; refusing to overwrite a previous run`,
    ])
  })

  it('resolves a relative --results-root before checking it', async () => {
    const root = await tempDir()
    const existing = join(root, 'm0-canned-replay')
    await mkdir(existing, { recursive: true })
    const relativeRoot = relative(process.cwd(), root)

    const { code, err } = await invoke([
      'run',
      '--manifest',
      manifestPath,
      '--results-root',
      relativeRoot,
    ])

    expect(relativeRoot).not.toBe(root)
    expect(code).toBe(2)
    expect(err).toStrictEqual([
      `configuration error: results directory already exists: ${existing}; refusing to overwrite a previous run`,
    ])
  })
})

describe('run command provider and grader selection', () => {
  it('refuses a live manifest without LiveKit credentials', async () => {
    const root = await tempDir()
    const manifest = await writeManifest(root, {
      provider: { mode: 'live', label: 'livekit/google/gemma-4-31b-it', allowLive: true },
    })

    const { code, err, out } = await invoke(
      ['run', '--manifest', manifest, '--results-root', join(root, 'results')],
      { env: {}, repoRoot },
    )

    expect(code).toBe(2)
    expect(out).toStrictEqual([])
    expect(err).toStrictEqual([
      'configuration error: a live run requires LIVEKIT_API_KEY (set it in .env or the environment)',
    ])
  })

  it('refuses a Jev-graded run without OPENROUTER_API_KEY', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '')
    const root = await tempDir()
    const manifest = await writeManifest(root, {
      grader: {
        id: 'jev',
        kind: 'system-one-model',
        version: 'typesafe/jev-1.14',
        model: 'typesafe/jev-1.14',
      },
    })

    const { code, err } = await invoke(
      ['run', '--manifest', manifest, '--results-root', join(root, 'results')],
      { env: {} },
    )

    expect(code).toBe(2)
    expect(err).toStrictEqual([
      'configuration error: a Jev-graded run requires OPENROUTER_API_KEY (set it in .env or the environment)',
    ])
  })

  it('treats a blank OPENROUTER_API_KEY as missing', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '   ')
    const root = await tempDir()
    const manifest = await writeManifest(root, {
      grader: {
        id: 'jev',
        kind: 'system-one-model',
        version: 'typesafe/jev-1.14',
        model: 'typesafe/jev-1.14',
      },
    })

    const { code, err } = await invoke(
      ['run', '--manifest', manifest, '--results-root', join(root, 'results')],
      { env: { OPENROUTER_API_KEY: '   ' } },
    )

    expect(code).toBe(2)
    expect(err).toStrictEqual([
      'configuration error: a Jev-graded run requires OPENROUTER_API_KEY (set it in .env or the environment)',
    ])
  })

  it('selects the Jev grader and refuses the unpinned rubric', async () => {
    // The deps env carries the key; the process env must not, so the test
    // proves the injected environment is the one the grader is built from.
    vi.stubEnv('OPENROUTER_API_KEY', '')
    const root = await tempDir()
    const manifest = await writeManifest(root, {
      grader: {
        id: 'jev',
        kind: 'system-one-model',
        version: 'typesafe/jev-1.14',
        model: 'typesafe/jev-1.14',
      },
    })

    const { code, err, out } = await invoke(
      ['run', '--manifest', manifest, '--results-root', join(root, 'results')],
      { env: { OPENROUTER_API_KEY: 'test-key' } },
    )

    expect(code).toBe(2)
    expect(out).toStrictEqual([])
    expect(err).toStrictEqual([
      'configuration error: rubric mismatch: manifest registers rubric "m0-harness-v1" but grader "jev" implements "m2-persona-rubric-v2"',
    ])
  })

  it('builds the turn-taking code grader for a manifest that registers it', async () => {
    const root = await tempDir()
    const results = join(root, 'results')
    const manifest = await writeManifest(root, {
      grader: { id: 'turn-taking-speakers', kind: 'code', version: '1.1.0' },
    })

    const { code, err, out } = await invoke([
      'run',
      '--manifest',
      manifest,
      '--results-root',
      results,
    ])

    expect(code).toBe(2)
    expect(out).toStrictEqual([])
    expect(err).toStrictEqual([
      'configuration error: grader "turn-taking-speakers" failed: turn-taking grader found no labelled multi-persona trials; labels are missing; a failed grader call is never a score',
    ])
  })

  it('uses an injected provider factory instead of the recorded replays', async () => {
    const root = await tempDir()
    const { code, out } = await invoke(
      ['run', '--manifest', manifestPath, '--results-root', root],
      {
        providerFactory: () => {
          throw new Error('injected provider factory was used')
        },
      },
    )

    expect(code).toBe(1)
    expect(out).toContain('verdict: inconclusive')
    expect(out).toContain('trials: 12 (12 failed)')
    await expect(
      readFile(join(root, 'm0-canned-replay', 'result.json'), 'utf8'),
    ).resolves.toContain('"failedTrials": 12')
  })

  it('uses an injected grader instead of the manifest-selected default', async () => {
    const root = await tempDir()
    const { code, err, out } = await invoke(
      ['run', '--manifest', manifestPath, '--results-root', root],
      { grader: throwingGrader('injected grader was used') },
    )

    expect(code).toBe(2)
    expect(out).toStrictEqual([])
    expect(err).toStrictEqual([
      'configuration error: grader "deterministic-invariants" failed: injected grader was used; a failed grader call is never a score',
    ])
  })

  it('stamps the injected code SHA into the result artifact', async () => {
    const root = await tempDir()
    const runDir = join(root, 'm0-canned-replay')
    const { code, out } = await invoke(
      ['run', '--manifest', manifestPath, '--results-root', root],
      { codeSha: 'abc1234' },
    )

    expect(code).toBe(0)
    const result = JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8')) as {
      versions: { codeSha?: string }
    }
    expect(result.versions.codeSha).toBe('abc1234')

    const resultsIndex = out.indexOf(`results: ${runDir}`)
    expect(resultsIndex).toBeGreaterThan(0)
    expect(out[resultsIndex - 1]).toBe('')
  })

  it('exports through the injected observer after writing the artifacts', async () => {
    const root = await tempDir()
    const runDir = join(root, 'm0-canned-replay')
    const plans: ObservationPlan[] = []

    const { code } = await invoke(['run', '--manifest', manifestPath, '--results-root', root], {
      env: {
        LANGFUSE_ENABLED: 'true',
        LANGFUSE_BASE_URL: 'http://127.0.0.1:3000',
        LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
        LANGFUSE_SECRET_KEY: 'sk-lf-test',
      },
      observerFactory: async (): Promise<EvaluationObserver> => ({
        async observe(plan) {
          plans.push(plan)
          return {
            experimentId: plan.executionId,
            traceIds: Object.fromEntries(
              plan.items.map((item) => [item.itemId, `trace-${item.itemId}`]),
            ),
          }
        },
        async shutdown() {},
      }),
    })

    expect(code).toBe(0)
    expect(plans).toHaveLength(1)
    expect(plans[0]?.items).toHaveLength(12)
    const artifact = JSON.parse(await readFile(join(runDir, 'langfuse.json'), 'utf8')) as {
      status: string
    }
    expect(artifact.status).toBe('exported')
  })

  it('refuses to persist a result whose manifest changed during execution', async () => {
    const root = await tempDir()
    const deterministic = createDeterministicInvariantGrader()
    const mutatingGrader: Grader = {
      ...deterministic,
      async score(context) {
        const metrics = await deterministic.score(context)
        context.manifest.run.runId = 'mutated-during-execution'
        return metrics
      },
    }

    const { code, err } = await invoke(
      ['run', '--manifest', manifestPath, '--results-root', root],
      { grader: mutatingGrader },
    )

    expect(code).toBe(2)
    expect(err).toStrictEqual([
      'configuration error: the manifest changed between validation and execution; refusing to persist a mismatched result',
    ])
    await expect(readFile(join(root, 'm0-canned-replay'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
