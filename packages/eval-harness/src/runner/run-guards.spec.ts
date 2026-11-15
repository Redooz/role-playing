import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { taskEntrySchema, type TaskEntry } from '../tasks/schema.js'
import { CannedProviderConfigError, ProviderUnavailableError } from './canned-provider.js'
import { HarnessConfigError } from './errors.js'
import type { Grader } from './grader.js'
import { parseManifest, type RunManifest } from './manifest.js'
import { buildCannedEntriesForTask } from './replay.js'
import {
  assertGraderMatchesManifest,
  assertSessionPrompt,
  createProviderFactory,
} from './run-guards.js'
import {
  GENERIC_PROMPT_TEMPLATE_VERSION,
  SESSION_PROMPT_TEMPLATE_VERSION,
  SESSION_PROMPT_TEMPLATE_VERSIONS,
  buildSessionCannedEntries,
} from './session-runner.js'
import type { LoadedTask } from './task-loader.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')

function loadTask(relativePath: string): LoadedTask {
  const raw = JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8')) as unknown
  return { task: taskEntrySchema.parse(raw), relativePath }
}

const replayTask = loadTask('evals/tasks/synthetic-workplace/v1/en/en-b1-report-deadline-001.json')
const sessionTask = loadTask(
  'evals/tasks/synthetic-workplace-session/v1/en/en-b1-deadline-manager-101.json',
)
const multiPersonaTask = loadTask(
  'evals/tasks/synthetic-multi-persona-session/m3b-v1/en/en-b2-scope-en-cal-201.json',
)

const baseRaw = JSON.parse(
  readFileSync(join(repoRoot, 'evals/manifests/m0-canned-replay.json'), 'utf8'),
) as Record<string, unknown>

const DATE = '2026-11-08'

function manifest(overrides: Record<string, unknown> = {}): RunManifest {
  return parseManifest({ ...structuredClone(baseRaw), ...overrides })
}

/** A valid prompt block; `version` is pinned to the harmony template. */
function prompt(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: SESSION_PROMPT_TEMPLATE_VERSION, currentDate: DATE, ...extra }
}

const codeGrader: Grader = {
  id: 'deterministic-invariants',
  kind: 'code',
  version: '1.0.0',
  score() {
    return Promise.resolve({ 'replay.deterministic_rate': 1 })
  },
}

function semanticManifest(): RunManifest {
  return manifest({
    grader: {
      id: 'jev',
      kind: 'system-one-model',
      version: 'typesafe/jev-1.14',
      model: 'typesafe/jev-1.14',
    },
    rubric: { version: 'm2-persona-rubric-v2', ids: ['m2-persona-rubric-v2'] },
  })
}

function captureError(run: () => void): HarnessConfigError {
  try {
    run()
  } catch (error) {
    if (error instanceof HarnessConfigError) return error
    throw error
  }
  throw new Error('expected a HarnessConfigError')
}

function expectGuardMessage(run: () => void, message: string): void {
  const error = captureError(run)
  expect(error).toBeInstanceOf(HarnessConfigError)
  expect(error.name).toBe('HarnessConfigError')
  expect(error.issues).toStrictEqual([])
  expect(error.message).toBe(message)
}

describe('assertGraderMatchesManifest', () => {
  it('accepts a grader that matches the manifest registration exactly', () => {
    expect(() => assertGraderMatchesManifest(codeGrader, manifest())).not.toThrow()
  })

  it('reports every mismatch field in one message', () => {
    const other: Grader = {
      id: 'jev',
      kind: 'human',
      version: 'typesafe/jev-1.13',
      score() {
        return Promise.resolve({ 'replay.deterministic_rate': 1 })
      },
    }

    expectGuardMessage(
      () => assertGraderMatchesManifest(other, manifest()),
      'grader mismatch: manifest registers "deterministic-invariants" (code) version "1.0.0" but the injected grader is "jev" (human) version "typesafe/jev-1.13"',
    )
  })

  it('rejects an id-only mismatch', () => {
    const other: Grader = { ...codeGrader, id: 'other-grader' }

    expectGuardMessage(
      () => assertGraderMatchesManifest(other, manifest()),
      'grader mismatch: manifest registers "deterministic-invariants" (code) version "1.0.0" but the injected grader is "other-grader" (code) version "1.0.0"',
    )
  })

  it('rejects a kind-only mismatch', () => {
    const other: Grader = { ...codeGrader, kind: 'human' }

    expectGuardMessage(
      () => assertGraderMatchesManifest(other, manifest()),
      'grader mismatch: manifest registers "deterministic-invariants" (code) version "1.0.0" but the injected grader is "deterministic-invariants" (human) version "1.0.0"',
    )
  })

  it('rejects a version-only mismatch', () => {
    const other: Grader = { ...codeGrader, version: '1.0.1' }

    expectGuardMessage(
      () => assertGraderMatchesManifest(other, manifest()),
      'grader mismatch: manifest registers "deterministic-invariants" (code) version "1.0.0" but the injected grader is "deterministic-invariants" (code) version "1.0.1"',
    )
  })

  it('rejects a system-one-model grader that declares no rubric', () => {
    const grader: Grader = {
      id: 'jev',
      kind: 'system-one-model',
      version: 'typesafe/jev-1.14',
      score() {
        return Promise.resolve({ 'replay.deterministic_rate': 1 })
      },
    }

    expectGuardMessage(
      () => assertGraderMatchesManifest(grader, semanticManifest()),
      'grader "jev" is a system-one-model grader but declares no rubric; the manifest\'s rubric cannot be checked',
    )
  })

  it('rejects a grader whose rubric is not the registered rubric', () => {
    const grader: Grader = {
      id: 'jev',
      kind: 'system-one-model',
      version: 'typesafe/jev-1.14',
      rubricVersion: 'm2-persona-rubric-v1',
      score() {
        return Promise.resolve({ 'replay.deterministic_rate': 1 })
      },
    }

    expectGuardMessage(
      () => assertGraderMatchesManifest(grader, semanticManifest()),
      'rubric mismatch: manifest registers rubric "m2-persona-rubric-v2" but grader "jev" implements "m2-persona-rubric-v1"',
    )
  })

  it('accepts a grader whose rubric is the registered rubric', () => {
    const grader: Grader = {
      id: 'jev',
      kind: 'system-one-model',
      version: 'typesafe/jev-1.14',
      rubricVersion: 'm2-persona-rubric-v2',
      score() {
        return Promise.resolve({ 'replay.deterministic_rate': 1 })
      },
    }

    expect(() => assertGraderMatchesManifest(grader, semanticManifest())).not.toThrow()
  })

  it('accepts a code grader that declares a matching rubric and ignores an absent one', () => {
    const withRubric: Grader = { ...codeGrader, rubricVersion: 'm0-harness-v1' }

    expect(() => assertGraderMatchesManifest(withRubric, manifest())).not.toThrow()
    expect(() => assertGraderMatchesManifest(codeGrader, manifest())).not.toThrow()
  })
})

describe('assertSessionPrompt', () => {
  it('does nothing when the selection has no session task', () => {
    expect(() => assertSessionPrompt(manifest(), [replayTask])).not.toThrow()
  })

  it('requires prompt.currentDate when any session task is selected', () => {
    expectGuardMessage(
      () => assertSessionPrompt(manifest(), [replayTask, sessionTask]),
      'a manifest selecting session tasks must register prompt.currentDate so the prompt is reproducible',
    )
  })

  it('accepts the pinned harmony template version', () => {
    expect(() => assertSessionPrompt(manifest({ prompt: prompt() }), [sessionTask])).not.toThrow()
  })

  it('accepts a prompt with no version and defaults to the persona mode', () => {
    expect(() =>
      assertSessionPrompt(manifest({ prompt: { currentDate: DATE } }), [sessionTask]),
    ).not.toThrow()
  })

  it('rejects a prompt version that does not match the persona template', () => {
    expectGuardMessage(
      () =>
        assertSessionPrompt(manifest({ prompt: prompt({ version: 'm2-prompt-v1' }) }), [
          sessionTask,
        ]),
      `manifest prompt version "m2-prompt-v1" does not match the persona template "${SESSION_PROMPT_TEMPLATE_VERSION}"`,
    )
  })

  it('names the persona template even when the mode is omitted', () => {
    expectGuardMessage(
      () =>
        assertSessionPrompt(manifest({ prompt: { version: 'm2-prompt-v0', currentDate: DATE } }), [
          sessionTask,
        ]),
      `manifest prompt version "m2-prompt-v0" does not match the persona template "${SESSION_PROMPT_TEMPLATE_VERSION}"`,
    )
  })

  it('accepts the gemma style template version', () => {
    expect(() =>
      assertSessionPrompt(
        manifest({
          prompt: prompt({ style: 'gemma', version: SESSION_PROMPT_TEMPLATE_VERSIONS['gemma'] }),
        }),
        [sessionTask],
      ),
    ).not.toThrow()
  })

  it('accepts the generic template version in generic mode', () => {
    expect(() =>
      assertSessionPrompt(
        manifest({
          prompt: { mode: 'generic', version: GENERIC_PROMPT_TEMPLATE_VERSION, currentDate: DATE },
        }),
        [sessionTask],
      ),
    ).not.toThrow()
  })

  it('rejects a persona template version in generic mode', () => {
    expectGuardMessage(
      () =>
        assertSessionPrompt(
          manifest({
            prompt: {
              mode: 'generic',
              version: SESSION_PROMPT_TEMPLATE_VERSION,
              currentDate: DATE,
            },
          }),
          [sessionTask],
        ),
      `manifest prompt version "${SESSION_PROMPT_TEMPLATE_VERSION}" does not match the generic template "${GENERIC_PROMPT_TEMPLATE_VERSION}"`,
    )
  })

  it('rejects a session task with no session block', () => {
    const withoutSession = structuredClone(sessionTask.task) as TaskEntry
    delete (withoutSession as { session?: unknown }).session

    expectGuardMessage(
      () =>
        assertSessionPrompt(manifest({ prompt: prompt() }), [
          { ...sessionTask, task: withoutSession },
        ]),
      `session task ${withoutSession.id} has no session block`,
    )
  })

  it('requires a multiPersona policy for a multi-persona session task', () => {
    expectGuardMessage(
      () => assertSessionPrompt(manifest({ prompt: prompt() }), [multiPersonaTask]),
      `multi-persona session task ${multiPersonaTask.task.id} requires a registered multiPersona policy`,
    )
  })

  it('accepts a multi-persona session task when a policy is registered', () => {
    expect(() =>
      assertSessionPrompt(manifest({ prompt: prompt(), multiPersona: { policy: 'det-persona' } }), [
        multiPersonaTask,
      ]),
    ).not.toThrow()
  })

  it('accepts a single-persona session task without a policy', () => {
    expect(() => assertSessionPrompt(manifest({ prompt: prompt() }), [sessionTask])).not.toThrow()
  })
})

describe('createProviderFactory', () => {
  it('builds a fresh live provider per trial from the manifest label', () => {
    const live = manifest({
      provider: { mode: 'live', label: 'm0-live-not-wired', allowLive: true },
    })
    const factory = createProviderFactory(live, [replayTask])
    const first = factory()
    const second = factory()

    expect(first).not.toBe(second)
    expect(first.kind).toBe('live')
    expect(first.label).toBe('m0-live-not-wired')

    const request = {
      provider: 'persona',
      model: 'm',
      messages: [{ role: 'user' as const, content: 'hi' }],
    }
    expect(() => first.complete(request)).toThrow(ProviderUnavailableError)
    expect(() => first.complete(request)).toThrow(
      'live provider "m0-live-not-wired" is not wired at M0; no network call was made',
    )
  })

  it('builds a canned provider labelled from the manifest', async () => {
    const factory = createProviderFactory(manifest(), [replayTask])
    const provider = factory()

    expect(provider.kind).toBe('canned')
    expect(provider.label).toBe('m0-task-persona-v1')

    const entry = buildCannedEntriesForTask(replayTask.task)[0]
    if (entry === undefined) throw new Error('the replay task has no persona turn')

    const chunks: string[] = []
    for await (const chunk of provider.complete(entry.request)) chunks.push(chunk.text)
    expect(chunks.join('')).toBe(replayTask.task.content.turns[0]?.text)
  })

  it('refuses canned session replay without a pinned prompt date', () => {
    expectGuardMessage(
      () => createProviderFactory(manifest(), [sessionTask]),
      `canned session replay for ${sessionTask.task.id} requires manifest.prompt.currentDate`,
    )
  })

  it('keys canned session entries by the gemma prompt pack the manifest pins', async () => {
    const gemma = manifest({
      prompt: {
        currentDate: DATE,
        style: 'gemma',
        version: SESSION_PROMPT_TEMPLATE_VERSIONS['gemma'],
      },
    })
    const provider = createProviderFactory(gemma, [sessionTask])()

    const entries = buildSessionCannedEntries(sessionTask.task, DATE, 'gemma', 'persona')
    const first = entries[0]
    if (first === undefined) throw new Error('no canned session entry')

    const chunks: string[] = []
    for await (const chunk of provider.complete(first.request)) chunks.push(chunk.text)
    expect(chunks.join('')).toBe(sessionTask.task.session?.recordedPersonaTurns?.[0])
  })

  it('validates the recorded bundle before any trial runs', () => {
    const duplicate: LoadedTask = {
      task: { ...replayTask.task, locale: 'en-GB' } as TaskEntry,
      relativePath: 'evals/tasks/synthetic-workplace/v1/en/duplicate.json',
    }

    expect(() => createProviderFactory(manifest(), [replayTask, duplicate])).toThrow(
      CannedProviderConfigError,
    )
    expect(() => createProviderFactory(manifest(), [replayTask, duplicate])).toThrow(
      /duplicates payload hash/u,
    )
  })
})
