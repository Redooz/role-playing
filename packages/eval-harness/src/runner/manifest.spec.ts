import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ManifestValidationError,
  formatManifestIssue,
  manifestHash,
  parseManifest,
  validateManifest,
} from './manifest.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const examplePath = join(repoRoot, 'evals/manifests/m0-canned-replay.json')
const incompletePath = join(repoRoot, 'evals/manifests/m0-incomplete-missing-limits.json')

/** Sections the pre-registered manifest must contain (gate G2). */
const REQUIRED_SECTIONS = [
  'run',
  'tasks',
  'seeds',
  'grader',
  'rubric',
  'limits',
  'target',
  'guardrails',
  'invariants',
  'provider',
] as const

function load(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function loadExample(): Record<string, unknown> {
  return load(examplePath)
}

describe('run manifest (gate G2)', () => {
  it('accepts the committed example manifest', () => {
    const result = validateManifest(loadExample())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.run.runId).toBe('m0-canned-replay')
    expect(result.manifest.tasks.languages).toEqual(['en', 'fr'])
    expect(result.manifestHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a capability eval with a zero minimum detectable effect', () => {
    const raw = loadExample()
    ;(raw['run'] as Record<string, unknown>)['purpose'] = 'capability'
    ;(raw['target'] as Record<string, unknown>)['minimumDetectableEffect'] = 0

    const result = validateManifest(raw)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map((issue) => issue.path)).toContain('target.minimumDetectableEffect')
  })

  it('accepts a capability eval with a positive minimum detectable effect', () => {
    const raw = loadExample()
    ;(raw['run'] as Record<string, unknown>)['purpose'] = 'capability'
    ;(raw['target'] as Record<string, unknown>)['minimumDetectableEffect'] = 0.01

    expect(validateManifest(raw).ok).toBe(true)
  })

  it('rejects a regression eval with a non-zero minimum detectable effect', () => {
    const raw = loadExample()
    ;(raw['target'] as Record<string, unknown>)['minimumDetectableEffect'] = 0.01

    const result = validateManifest(raw)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map((issue) => issue.path)).toContain('target.minimumDetectableEffect')
  })

  it('rejects the deliberately incomplete example used by the CLI test', () => {
    const result = validateManifest(load(incompletePath))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map((issue) => issue.path)).toContain('limits')
    expect(result.issues.map((issue) => issue.message).join('; ')).toContain(
      'limits: missing required field',
    )
  })

  it.each(REQUIRED_SECTIONS)(
    'rejects a manifest without a %s section and names the missing field',
    (section) => {
      const raw = loadExample()
      delete raw[section]

      const result = validateManifest(raw)
      expect(result.ok).toBe(false)
      if (result.ok) return

      const messages = result.issues.map((issue) => issue.message)
      expect(messages).toContain(`${section}: missing required field`)
      expect(result.issues.map((issue) => issue.path)).toContain(section)
    },
  )

  it('accepts a prompt style and rejects an unknown one', () => {
    const raw = loadExample()
    raw['prompt'] = { style: 'gemma', currentDate: '2026-11-08' }
    expect(validateManifest(raw).ok).toBe(true)

    const unknown = loadExample()
    unknown['prompt'] = { style: 'gemini', currentDate: '2026-11-08' }
    const result = validateManifest(unknown)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map((issue) => issue.path)).toContain('prompt.style')
  })

  it('names a missing nested minimum detectable effect', () => {
    const raw = loadExample()
    const target = raw['target'] as Record<string, unknown>
    delete target['minimumDetectableEffect']

    const result = validateManifest(raw)
    expect(result.ok).toBe(false)
    if (result.ok) return

    const messages = result.issues.map((issue) => issue.message)
    expect(messages).toContain('target.minimumDetectableEffect: missing required field')
  })

  it('throws ManifestValidationError from parseManifest with every issue', () => {
    const raw = loadExample()
    delete raw['limits']
    delete raw['rubric']

    let thrown: unknown
    try {
      parseManifest(raw)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ManifestValidationError)
    if (!(thrown instanceof ManifestValidationError)) return
    expect(thrown.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['limits', 'rubric']),
    )
    expect(thrown.message).toContain('limits: missing required field')
    expect(thrown.message).toContain('rubric: missing required field')
    for (const issue of thrown.issues) expect(formatManifestIssue(issue)).toContain(issue.path)
  })

  it('refuses a live provider without explicit opt-in', () => {
    const raw = loadExample()
    raw['provider'] = { mode: 'live', label: 'm0-live', allowLive: false }

    const result = validateManifest(raw)
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.issues.map((issue) => issue.path)).toContain('provider.allowLive')
    expect(result.issues.map((issue) => issue.message).join('; ')).toContain('allowLive')
  })

  it('rejects duplicate guardrails and a target duplicated as a guardrail', () => {
    const raw = loadExample()
    const guardrails = raw['guardrails'] as Record<string, unknown>[]
    guardrails.push({ metric: 'transcript.guard_violations', direction: 'decrease', tolerance: 0 })

    const duplicate = validateManifest(raw)
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) {
      expect(duplicate.issues.map((issue) => issue.path)).toContain('guardrails')
    }

    const rawTargetAlsoGuardrail = loadExample()
    const target = rawTargetAlsoGuardrail['target'] as Record<string, unknown>
    const guards = rawTargetAlsoGuardrail['guardrails'] as Record<string, unknown>[]
    guards.push({ metric: target['metric'], direction: 'increase', tolerance: 0 })

    const overlap = validateManifest(rawTargetAlsoGuardrail)
    expect(overlap.ok).toBe(false)
    if (!overlap.ok) {
      expect(overlap.issues.map((issue) => issue.path)).toContain('target.metric')
    }
  })

  it('has the same hash regardless of JSON key order', () => {
    const raw = loadExample()
    const reordered = Object.fromEntries(Object.entries(raw).reverse())

    const first = parseManifest(raw)
    const second = parseManifest(reordered)

    expect(manifestHash(first)).toBe(manifestHash(second))
    expect(manifestHash(first)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('multi-persona registration', () => {
  it('accepts both registered live arms and rejects an unknown one', () => {
    const raw = loadExample()
    raw['multiPersona'] = { policy: 'fixed-rotation' }
    expect(validateManifest(raw).ok).toBe(true)
    raw['multiPersona'] = { policy: 'det-persona' }
    expect(validateManifest(raw).ok).toBe(true)
    raw['multiPersona'] = { policy: 'jev-persona' }
    const result = validateManifest(raw)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map((issue) => issue.path)).toContain('multiPersona.policy')
  })
})
