import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessConfigError, ManifestValidationError } from '@rp/eval-harness'
import { HELP_TEXT } from './cli-args.js'
import { defaultRepoRoot } from './cli-workspace.js'
import { main, type CliIo } from './cli-main.js'

/**
 * `main` is the CLI boundary: it owns the exit-code map (0 accepted/clean,
 * 1 rejected/inconclusive/violations, 2 usage or configuration) and renders
 * each error class. Dispatch is asserted in process so the coverage belongs to
 * this module, not to a spawned child.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const manifestPath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')
const incompleteManifestPath = join(repoRoot, 'evals/manifests/m0-incomplete-missing-limits.json')
const baselinePath = join(repoRoot, 'evals/baselines/m0-canned-replay.json')

const HELP_LINES = HELP_TEXT.split('\n')

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
  const dir = await mkdtemp(join(tmpdir(), 'eval-cli-main-'))
  tempDirs.push(dir)
  return dir
}

async function invoke(
  args: readonly string[],
  deps: Record<string, unknown> = {},
): Promise<{ code: number } & Capture> {
  const capture = captureIo()
  const code = await main(args, capture.io, {
    repoRoot,
    env: { LANGFUSE_ENABLED: 'false' },
    ...deps,
  })
  return { code, ...capture }
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('main command routing', () => {
  it('reports a missing command on stderr together with the usage text', async () => {
    const { code, err, out } = await invoke([])

    expect(code).toBe(2)
    expect(out).toStrictEqual([])
    expect(err).toStrictEqual(['missing command', ...HELP_LINES])
  })

  it.each([['help'], ['--help'], ['run', '--help'], ['compare', '-h']])(
    'prints usage for %s',
    async (...args: string[]) => {
      const { code, err, out } = await invoke(args)

      expect(code).toBe(0)
      expect(out).toStrictEqual(HELP_LINES)
      expect(err).toStrictEqual([])
    },
  )

  it('rejects an empty command name', async () => {
    const { code, err, out } = await invoke([''])

    expect(code).toBe(2)
    expect(out).toStrictEqual([])
    expect(err).toStrictEqual(['unknown command ""', 'run with --help for usage'])
  })

  it('reports a missing command for a sparse argument list', async () => {
    // `readonly string[]` can contain a hole at runtime; the guard names it.
    const { code, err, out } = await invoke(new Array<string>(1))

    expect(code).toBe(2)
    expect(out).toStrictEqual([])
    expect(err).toStrictEqual(['missing command'])
  })

  it('rejects an unknown command', async () => {
    const { code, err, out } = await invoke(['frobnicate'])

    expect(code).toBe(2)
    expect(out).toStrictEqual([])
    expect(err).toStrictEqual(['unknown command "frobnicate"', 'run with --help for usage'])
  })

  it('maps a flag parsing error to exit 2 with the usage hint', async () => {
    const { code, err, out } = await invoke(['compare', 'positional'])

    expect(code).toBe(2)
    expect(out).toStrictEqual([])
    expect(err).toStrictEqual(['unexpected argument "positional"', 'run with --help for usage'])
  })

  it('maps a command usage error to exit 2 with the usage hint', async () => {
    const { code, err } = await invoke(['run', '--scores', 'all'])

    expect(code).toBe(2)
    expect(err).toStrictEqual(['unknown flag --scores', 'run with --help for usage'])
  })

  it('dispatches compare', async () => {
    const { code, out } = await invoke([
      'compare',
      '--baseline',
      baselinePath,
      '--run',
      baselinePath,
    ])

    expect(code).toBe(0)
    expect(out[0]).toBe('comparison: PASS')
  })

  it('prefers the injected repository root over --repo-root', async () => {
    const injected = await tempDir()
    await mkdir(join(injected, 'evals'))
    const flagged = await tempDir()
    const { code, out } = await invoke(['validate-tasks', '--repo-root', flagged], {
      repoRoot: injected,
    })

    expect(code).toBe(0)
    expect(out).toStrictEqual([`tasks: 0 violations under ${join(injected, 'evals')}`])
  })

  it('uses --repo-root when no root is injected', async () => {
    const flagged = await tempDir()
    const { code, err, out } = await invoke(['validate-tasks', '--repo-root', flagged], {
      repoRoot: undefined,
    })

    expect(code).toBe(1)
    expect(out).toStrictEqual([])
    expect(err[0]).toBe(`tasks: 1 violation(s) under ${join(flagged, 'evals')}`)
  })

  it('falls back to the repository root that contains this source file', async () => {
    const { code, out } = await invoke(['validate-tasks'], { repoRoot: undefined })

    expect(code).toBe(0)
    expect(out).toStrictEqual([`tasks: 0 violations under ${join(defaultRepoRoot(), 'evals')}`])
  })

  it('dispatches run and maps a rejected manifest to exit 2', async () => {
    const root = await tempDir()
    const { code, err } = await invoke([
      'run',
      '--manifest',
      incompleteManifestPath,
      '--results-root',
      root,
    ])

    expect(code).toBe(2)
    expect(err).toStrictEqual([
      `manifest rejected (${incompleteManifestPath}):`,
      '  limits: missing required field',
      'nothing was executed; 1 manifest field(s) need attention',
    ])
  })
})

describe('main error rendering', () => {
  it('renders a ManifestValidationError thrown by a dependency', async () => {
    const root = await tempDir()
    const { code, err, out } = await invoke(
      ['run', '--manifest', manifestPath, '--results-root', root],
      {
        wallClock: () => {
          throw new ManifestValidationError([{ path: 'limits.rounds', message: 'is not positive' }])
        },
      },
    )

    expect(code).toBe(2)
    expect(out).toStrictEqual([])
    expect(err).toStrictEqual(['manifest rejected:', '  is not positive'])
  })

  it('renders a HarnessConfigError with its issues', async () => {
    const root = await tempDir()
    const { code, err, out } = await invoke(
      ['run', '--manifest', manifestPath, '--results-root', root],
      {
        wallClock: () => {
          throw new HarnessConfigError('the clock is unusable', [
            { path: 'seeds.master', message: 'is not a seed' },
          ])
        },
      },
    )

    expect(code).toBe(2)
    expect(out).toStrictEqual([])
    expect(err).toStrictEqual(['configuration error: the clock is unusable', '  is not a seed'])
  })

  it('renders an unknown thrown value under a generic error prefix', async () => {
    const root = await tempDir()
    const { code, err, out } = await invoke(
      ['run', '--manifest', manifestPath, '--results-root', root],
      {
        wallClock: () => {
          throw 'clock exploded'
        },
      },
    )

    expect(code).toBe(2)
    expect(out).toStrictEqual([])
    expect(err).toStrictEqual(['error: clock exploded'])
  })
})

describe('main default IO', () => {
  it('writes usage to stdout when no IO is injected', async () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })

    const code = await main(['help'])

    expect(spy).toHaveBeenCalled()
    expect(code).toBe(0)
    expect(writes.join('')).toBe(`${HELP_LINES.join('\n')}\n`)
  })

  it('writes the missing-command error to stderr when no IO is injected', async () => {
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })

    const code = await main([])

    expect(code).toBe(2)
    expect(writes.join('')).toBe(`${['missing command', ...HELP_LINES].join('\n')}\n`)
  })
})
