import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CliUsageError } from './cli-errors.js'
import type { CliIo } from './cli-contract.js'
import { validateTasksCommand } from './validate-tasks-command.js'

/**
 * `validate-tasks` is gate G3 at the terminal: exit 0 only for a clean tree,
 * one stderr line per violation, and the `evals/` path it inspected.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')

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
  const dir = await mkdtemp(join(tmpdir(), 'eval-cli-validate-tasks-'))
  tempDirs.push(dir)
  return dir
}

async function usageError(run: () => Promise<unknown>): Promise<CliUsageError> {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error
    return error
  }
  throw new Error('expected a CliUsageError')
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('validateTasksCommand', () => {
  it('reports zero violations for the committed task tree and exits 0', async () => {
    const capture = captureIo()

    const code = await validateTasksCommand(new Map(), repoRoot, capture.io)

    expect(code).toBe(0)
    expect(capture.out).toStrictEqual([`tasks: 0 violations under ${join(repoRoot, 'evals')}`])
    expect(capture.err).toStrictEqual([])
  })

  it('reports zero violations through the --repo-root flag', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'evals'))
    const capture = captureIo()

    const code = await validateTasksCommand(new Map([['repo-root', root]]), root, capture.io)

    expect(code).toBe(0)
    expect(capture.out).toStrictEqual([`tasks: 0 violations under ${join(root, 'evals')}`])
    expect(capture.err).toStrictEqual([])
  })

  it('reports a missing evals directory as one violation and exits 1', async () => {
    const root = await tempDir()
    const capture = captureIo()

    const code = await validateTasksCommand(new Map(), root, capture.io)

    expect(code).toBe(1)
    expect(capture.out).toStrictEqual([])
    expect(capture.err).toStrictEqual([
      `tasks: 1 violation(s) under ${join(root, 'evals')}`,
      `  evals: [EVALS_DIR_MISSING] expected an evals/ directory under ${root}`,
    ])
  })

  it('prints every violation, in tree order, and exits 1', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'evals', 'tasks'), { recursive: true })
    await writeFile(join(root, 'evals', 'tasks', 'zz.json'), '{}', 'utf8')
    await writeFile(join(root, 'evals', 'tasks', 'aa.json'), '{}', 'utf8')
    const capture = captureIo()

    const code = await validateTasksCommand(new Map(), root, capture.io)

    expect(code).toBe(1)
    expect(capture.out).toStrictEqual([])
    expect(capture.err).toStrictEqual([
      `tasks: 2 violation(s) under ${join(root, 'evals')}`,
      '  evals/tasks/aa.json: [INVALID_LAYOUT] task files must live at evals/tasks/<dataset>/<version>/<lang>/**.json with lang in en|fr',
      '  evals/tasks/zz.json: [INVALID_LAYOUT] task files must live at evals/tasks/<dataset>/<version>/<lang>/**.json with lang in en|fr',
    ])
  })

  it('rejects an unknown flag before validating anything', async () => {
    const capture = captureIo()

    const error = await usageError(() =>
      validateTasksCommand(new Map([['manifest', 'm.json']]), repoRoot, capture.io),
    )

    expect(error.message).toBe('unknown flag --manifest')
    expect(capture.out).toStrictEqual([])
    expect(capture.err).toStrictEqual([])
  })
})
