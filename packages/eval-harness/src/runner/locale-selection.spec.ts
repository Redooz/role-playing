import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseManifest, validateManifest } from './manifest.js'
import { loadSelectedTasks } from './runner.js'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

const baseManifest = {
  schemaVersion: '3.0.0',
  run: { runId: 'm2-selection', suite: 'm2-selection', purpose: 'regression' },
  tasks: {
    dataset: 'synthetic-workplace-session',
    version: 'v1',
    languages: ['en', 'fr'],
  },
  seeds: { master: 1, algorithm: 'mulberry32' },
  grader: { id: 'deterministic-invariants', kind: 'code', version: '1.0.0' },
  rubric: { version: 'm2-harness-v1' },
  limits: { rounds: 1, maxFailureRate: 0 },
  target: {
    metric: 'replay.deterministic_rate',
    direction: 'increase',
    minimumDetectableEffect: 0,
  },
  guardrails: [{ metric: 'run.failure_rate', direction: 'decrease', tolerance: 0 }],
  invariants: ['transcript.schema_valid'],
  provider: { mode: 'canned', label: 'canned', allowLive: false },
  prompt: { version: 'm2-prompt-v2', mode: 'persona', currentDate: '2026-11-08' },
}

describe('locale task selection', () => {
  it('selects only the base variants when no locales filter is registered', async () => {
    const manifest = parseManifest(baseManifest)
    const tasks = await loadSelectedTasks(REPO_ROOT, manifest.tasks)
    expect(tasks).toHaveLength(6)
    expect(tasks.every(({ task }) => (task.locale ?? task.lang) === task.lang)).toBe(true)
  })

  it('selects only the requested locale variants for a probe', async () => {
    const manifest = parseManifest({
      ...baseManifest,
      tasks: { ...baseManifest.tasks, locales: ['en-GB', 'fr-CA'] },
    })
    const tasks = await loadSelectedTasks(REPO_ROOT, manifest.tasks)
    expect(tasks).toHaveLength(6)
    expect(new Set(tasks.map(({ task }) => task.locale))).toEqual(new Set(['en-GB', 'fr-CA']))
  })

  it('rejects a locale whose base language is not selected', () => {
    const validation = validateManifest({
      ...baseManifest,
      tasks: { ...baseManifest.tasks, languages: ['en'], locales: ['fr-CA'] },
    })
    expect(validation.ok).toBe(false)
  })

  it('fails when a requested locale has no task', async () => {
    const manifest = parseManifest({
      ...baseManifest,
      tasks: { ...baseManifest.tasks, locales: ['fr'] },
    })
    await expect(loadSelectedTasks(REPO_ROOT, manifest.tasks)).rejects.toThrow(/language "en"/)
  })
})
