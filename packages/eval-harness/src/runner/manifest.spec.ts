import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  EVAL_PURPOSES,
  GRADER_KINDS,
  INVARIANT_IDS,
  MANIFEST_SCHEMA_VERSION,
  ManifestValidationError,
  baselineReferenceSchema,
  evalPurposeSchema,
  formatManifestIssue,
  graderKindSchema,
  graderRegistrationSchema,
  guardrailRegistrationSchema,
  invariantIdSchema,
  invariantResultSchema,
  limitRegistrationSchema,
  manifestHash,
  metricDirectionSchema,
  metricNameSchema,
  multiPersonaRegistrationSchema,
  parseManifest,
  promptRegistrationSchema,
  providerRegistrationSchema,
  rubricRegistrationSchema,
  runIdentitySchema,
  runManifestSchema,
  seedRegistrationSchema,
  targetRegistrationSchema,
  taskSelectionSchema,
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

// ---------------------------------------------------------------------------
// Field-level schema rules
// ---------------------------------------------------------------------------

interface RawIssueLike {
  readonly code?: string
  readonly path: readonly PropertyKey[]
  readonly message: string
}

interface ParseableSchema {
  safeParse(input: unknown):
    | { readonly success: true }
    | {
        readonly success: false
        readonly error: { readonly issues: readonly RawIssueLike[] }
      }
}

interface ReportedIssue {
  readonly code: string | undefined
  readonly path: string
  readonly message: string
}

function issuesOf(schema: ParseableSchema, input: unknown): ReportedIssue[] {
  const result = schema.safeParse(input)
  if (result.success) return []
  return result.error.issues.map((issue) => ({
    code: issue.code,
    path: issue.path.join('.'),
    message: issue.message,
  }))
}

function messagesAt(schema: ParseableSchema, input: unknown, path: string): string[] {
  return issuesOf(schema, input)
    .filter((issue) => issue.path === path)
    .map((issue) => issue.message)
}

/** A custom refinement issue also declares its Zod issue code. */
function customIssue(
  schema: ParseableSchema,
  input: unknown,
  path: string,
): ReportedIssue | undefined {
  return issuesOf(schema, input).find((issue) => issue.path === path && issue.code === 'custom')
}

function pathsOf(schema: ParseableSchema, input: unknown): string[] {
  return issuesOf(schema, input).map((issue) => issue.path)
}

/** One manifest-level issue, found by its rendered path. */
function manifestIssue(input: unknown, path: string): { path: string; message: string } {
  const result = validateManifest(input)
  if (result.ok) throw new Error(`expected the manifest to be rejected at ${path}`)
  const issue = result.issues.find((entry) => entry.path === path)
  if (issue === undefined) {
    throw new Error(
      `no issue at ${path}; got ${result.issues.map((entry) => entry.path).join(', ')}`,
    )
  }
  return { path: issue.path, message: issue.message }
}

describe('metric registration fields', () => {
  it.each(['a', 'a1', 'replay.deterministic_rate', 'a1.b-c_d'])(
    'accepts %s as a metric name',
    (metric) => {
      expect(metricNameSchema.safeParse(metric).success).toBe(true)
    },
  )

  it.each(['', 'A', '1a', 'a b', 'a/b', 'a!'])('rejects %s as a metric name', (metric) => {
    expect(metricNameSchema.safeParse(metric).success).toBe(false)
  })

  it('states the metric-name rule', () => {
    expect(messagesAt(metricNameSchema, 'Bad', '')).toEqual([
      'must start with a lowercase letter and contain only lowercase letters, digits, ".", "_" or "-"',
    ])
  })

  it('accepts both directions and rejects an unknown one', () => {
    expect(metricDirectionSchema.safeParse('increase').success).toBe(true)
    expect(metricDirectionSchema.safeParse('decrease').success).toBe(true)
    expect(metricDirectionSchema.safeParse('higher').success).toBe(false)
  })
})

describe('invariant registration', () => {
  it('registers the five hard invariants in order', () => {
    expect(INVARIANT_IDS).toEqual([
      'transcript.schema_valid',
      'transcript.guard_clean',
      'transcript.seq_monotonic',
      'transcript.content_class',
      'response.plain_text',
    ])
  })

  it.each([...INVARIANT_IDS])('accepts the registered invariant %s', (id) => {
    expect(invariantIdSchema.safeParse(id).success).toBe(true)
  })

  it('rejects an unregistered invariant id', () => {
    expect(invariantIdSchema.safeParse('transcript.unknown').success).toBe(false)
  })

  it('accepts an invariant result with and without detail', () => {
    expect(invariantResultSchema.safeParse({ id: 'response.plain_text', ok: true }).success).toBe(
      true,
    )
    expect(
      invariantResultSchema.safeParse({
        id: 'response.plain_text',
        ok: false,
        detail: 'Markdown survived the streaming filter',
      }).success,
    ).toBe(true)
  })

  it('rejects an empty detail, missing fields and unknown keys', () => {
    expect(
      pathsOf(invariantResultSchema, { id: 'response.plain_text', ok: true, detail: '' }),
    ).toContain('detail')
    expect(pathsOf(invariantResultSchema, { ok: true })).toContain('id')
    expect(pathsOf(invariantResultSchema, { id: 'response.plain_text' })).toContain('ok')
    expect(
      pathsOf(invariantResultSchema, { id: 'response.plain_text', ok: true, extra: 1 }),
    ).toContain('')
  })
})

describe('purpose and grader kinds', () => {
  it('registers exactly the two eval purposes', () => {
    expect(EVAL_PURPOSES).toEqual(['capability', 'regression'])
  })

  it.each([...EVAL_PURPOSES])('accepts the %s purpose', (purpose) => {
    expect(evalPurposeSchema.safeParse(purpose).success).toBe(true)
  })

  it('rejects an unknown purpose', () => {
    expect(evalPurposeSchema.safeParse('evaluation').success).toBe(false)
  })

  it('registers exactly the three grader kinds', () => {
    expect(GRADER_KINDS).toEqual(['code', 'system-one-model', 'human'])
  })

  it.each([...GRADER_KINDS])('accepts the %s grader kind', (kind) => {
    expect(graderKindSchema.safeParse(kind).success).toBe(true)
  })

  it('rejects an unknown grader kind', () => {
    expect(graderKindSchema.safeParse('llm').success).toBe(false)
  })
})

describe('run identity fields', () => {
  it('accepts a path-safe id with and without a description', () => {
    expect(
      runIdentitySchema.safeParse({
        runId: 'm0-canned-replay',
        suite: 'm0-canned-replay',
        purpose: 'regression',
      }).success,
    ).toBe(true)
    expect(
      runIdentitySchema.safeParse({
        runId: 'm0-canned-replay',
        suite: 'm0-canned-replay',
        purpose: 'capability',
        description: 'A focused replay',
      }).success,
    ).toBe(true)
  })

  it.each(['', '-run', 'run/id', 'a b'])('rejects the run id %s', (runId) => {
    expect(pathsOf(runIdentitySchema, { runId, suite: 'suite', purpose: 'capability' })).toContain(
      'runId',
    )
  })

  it('states the path-safe id rule', () => {
    expect(
      messagesAt(
        runIdentitySchema,
        { runId: 'run/id', suite: 'suite', purpose: 'capability' },
        'runId',
      ),
    ).toEqual([
      'must start with a letter or digit and contain only letters, digits, ".", "_" or "-"',
    ])
  })

  it('requires suite and purpose, rejects an empty description and unknown keys', () => {
    expect(pathsOf(runIdentitySchema, { runId: 'run' })).toEqual(
      expect.arrayContaining(['suite', 'purpose']),
    )
    expect(
      pathsOf(runIdentitySchema, {
        runId: 'run',
        suite: 'suite',
        purpose: 'capability',
        description: '',
      }),
    ).toContain('description')
    expect(
      pathsOf(runIdentitySchema, {
        runId: 'run',
        suite: 'suite',
        purpose: 'capability',
        extra: true,
      }),
    ).toContain('')
  })
})

describe('task selection rules', () => {
  it('accepts a minimal selection and a fully filtered one', () => {
    expect(
      taskSelectionSchema.safeParse({
        dataset: 'synthetic-workplace',
        version: 'v1',
        languages: ['en'],
      }).success,
    ).toBe(true)
    expect(
      taskSelectionSchema.safeParse({
        dataset: 'synthetic-workplace',
        version: 'v1',
        languages: ['en', 'fr'],
        locales: ['en-GB', 'fr-CA'],
        splits: ['calibration', 'holdout'],
        ids: ['task-1', 'task-2'],
      }).success,
    ).toBe(true)
  })

  it('rejects an empty language list, an unknown language and duplicates', () => {
    expect(pathsOf(taskSelectionSchema, { dataset: 'd', version: 'v1', languages: [] })).toContain(
      'languages',
    )
    expect(
      pathsOf(taskSelectionSchema, { dataset: 'd', version: 'v1', languages: ['de'] }),
    ).toContain('languages.0')
    expect(
      customIssue(
        taskSelectionSchema,
        { dataset: 'd', version: 'v1', languages: ['en', 'en'] },
        'languages',
      ),
    ).toEqual({ code: 'custom', path: 'languages', message: 'languages must not repeat' })
  })

  it('rejects duplicate splits and an unknown split', () => {
    expect(
      customIssue(
        taskSelectionSchema,
        {
          dataset: 'd',
          version: 'v1',
          languages: ['en'],
          splits: ['calibration', 'calibration'],
        },
        'splits',
      ),
    ).toEqual({ code: 'custom', path: 'splits', message: 'splits must not repeat' })
    expect(
      pathsOf(taskSelectionSchema, {
        dataset: 'd',
        version: 'v1',
        languages: ['en'],
        splits: ['train'],
      }),
    ).toContain('splits.0')
  })

  it('rejects an empty locale list and duplicate locales', () => {
    expect(
      pathsOf(taskSelectionSchema, {
        dataset: 'd',
        version: 'v1',
        languages: ['en'],
        locales: [],
      }),
    ).toContain('locales')
    expect(
      customIssue(
        taskSelectionSchema,
        {
          dataset: 'd',
          version: 'v1',
          languages: ['en'],
          locales: ['en-GB', 'en-GB'],
        },
        'locales',
      ),
    ).toEqual({ code: 'custom', path: 'locales', message: 'locales must not repeat' })
  })

  it('accepts a locale only when its language is selected', () => {
    expect(
      taskSelectionSchema.safeParse({
        dataset: 'd',
        version: 'v1',
        languages: ['en'],
        locales: ['en-GB'],
      }).success,
    ).toBe(true)
    expect(
      customIssue(
        taskSelectionSchema,
        {
          dataset: 'd',
          version: 'v1',
          languages: ['fr'],
          locales: ['en-GB'],
        },
        'locales',
      ),
    ).toEqual({
      code: 'custom',
      path: 'locales',
      message: 'locale "en-GB" does not belong to a selected language',
    })
    expect(
      pathsOf(taskSelectionSchema, {
        dataset: 'd',
        version: 'v1',
        languages: ['en'],
        locales: ['xx'],
      }),
    ).toContain('locales')
  })

  it('rejects an empty id list and duplicate ids', () => {
    expect(
      pathsOf(taskSelectionSchema, {
        dataset: 'd',
        version: 'v1',
        languages: ['en'],
        ids: [],
      }),
    ).toContain('ids')
    expect(
      customIssue(
        taskSelectionSchema,
        {
          dataset: 'd',
          version: 'v1',
          languages: ['en'],
          ids: ['task-1', 'task-1'],
        },
        'ids',
      ),
    ).toEqual({ code: 'custom', path: 'ids', message: 'ids must not repeat' })
  })

  it('rejects empty ids, unknown fields and unsafe dataset/version ids', () => {
    expect(
      pathsOf(taskSelectionSchema, {
        dataset: 'd',
        version: 'v1',
        languages: ['en'],
        ids: [''],
      }),
    ).toContain('ids.0')
    expect(
      pathsOf(taskSelectionSchema, {
        dataset: 'd',
        version: 'v1',
        languages: ['en'],
        extra: true,
      }),
    ).toContain('')
    expect(
      pathsOf(taskSelectionSchema, { dataset: 'a/b', version: 'v1', languages: ['en'] }),
    ).toContain('dataset')
    expect(
      pathsOf(taskSelectionSchema, { dataset: 'd', version: '-v1', languages: ['en'] }),
    ).toContain('version')
  })
})

describe('seed registration fields', () => {
  it('accepts the documented PRNG and a zero seed', () => {
    expect(seedRegistrationSchema.safeParse({ master: 0, algorithm: 'mulberry32' }).success).toBe(
      true,
    )
    expect(
      seedRegistrationSchema.safeParse({ master: 20261025, algorithm: 'mulberry32' }).success,
    ).toBe(true)
  })

  it('rejects a negative or fractional master seed', () => {
    expect(pathsOf(seedRegistrationSchema, { master: -1, algorithm: 'mulberry32' })).toContain(
      'master',
    )
    expect(pathsOf(seedRegistrationSchema, { master: 1.5, algorithm: 'mulberry32' })).toContain(
      'master',
    )
  })

  it('requires the mulberry32 literal and no unknown keys', () => {
    expect(pathsOf(seedRegistrationSchema, { master: 1, algorithm: 'Mulberry32' })).toContain(
      'algorithm',
    )
    expect(
      pathsOf(seedRegistrationSchema, { master: 1, algorithm: 'mulberry32', extra: true }),
    ).toContain('')
  })
})

describe('grader registration rules', () => {
  it('accepts a code grader and a human grader without a model', () => {
    expect(
      graderRegistrationSchema.safeParse({
        id: 'deterministic-invariants',
        kind: 'code',
        version: '1.0.0',
      }).success,
    ).toBe(true)
    expect(
      graderRegistrationSchema.safeParse({
        id: 'reference-labels',
        kind: 'human',
        version: '1.0.0',
      }).success,
    ).toBe(true)
  })

  it('accepts a system-one-model grader with its pinned model', () => {
    expect(
      graderRegistrationSchema.safeParse({
        id: 'jev',
        kind: 'system-one-model',
        version: 'typesafe/jev-1.14',
        model: 'typesafe/jev-1.14',
      }).success,
    ).toBe(true)
  })

  it('requires a model for a system-one-model grader', () => {
    expect(
      customIssue(
        graderRegistrationSchema,
        { id: 'jev', kind: 'system-one-model', version: 'typesafe/jev-1.14' },
        'model',
      ),
    ).toEqual({
      code: 'custom',
      path: 'model',
      message: 'a system-one-model grader must name its pinned model',
    })
  })

  it.each(['code', 'human'])('rejects a model on a %s grader', (kind) => {
    expect(
      customIssue(
        graderRegistrationSchema,
        { id: 'grader', kind, version: '1.0.0', model: 'typesafe/jev-1.14' },
        'model',
      ),
    ).toEqual({
      code: 'custom',
      path: 'model',
      message: 'only a system-one-model grader may name a model',
    })
  })

  it('rejects empty id/version, an unknown kind and unknown keys', () => {
    expect(pathsOf(graderRegistrationSchema, { id: '', kind: 'code', version: '1.0.0' })).toContain(
      'id',
    )
    expect(
      pathsOf(graderRegistrationSchema, { id: 'grader', kind: 'code', version: '' }),
    ).toContain('version')
    expect(
      pathsOf(graderRegistrationSchema, { id: 'grader', kind: 'llm', version: '1.0.0' }),
    ).toContain('kind')
    expect(
      pathsOf(graderRegistrationSchema, {
        id: 'grader',
        kind: 'code',
        version: '1.0.0',
        extra: true,
      }),
    ).toContain('')
  })
})

describe('rubric, limit, target and guardrail registrations', () => {
  it('accepts rubric ids and rejects an empty list', () => {
    expect(
      rubricRegistrationSchema.safeParse({
        version: 'm0-harness-v1',
        ids: ['rubric-a', 'rubric-b'],
      }).success,
    ).toBe(true)
    expect(rubricRegistrationSchema.safeParse({ version: 'm0-harness-v1' }).success).toBe(true)
    expect(pathsOf(rubricRegistrationSchema, { version: 'm0-harness-v1', ids: [] })).toContain(
      'ids',
    )
    expect(pathsOf(rubricRegistrationSchema, { version: 'm0-harness-v1', ids: [''] })).toContain(
      'ids.0',
    )
    expect(pathsOf(rubricRegistrationSchema, { version: '', ids: ['r'] })).toContain('version')
    expect(pathsOf(rubricRegistrationSchema, { version: 'v1', ids: ['r'], extra: true })).toContain(
      '',
    )
  })

  it('accepts the registered limit boundaries', () => {
    expect(limitRegistrationSchema.safeParse({ rounds: 1, maxFailureRate: 0 }).success).toBe(true)
    expect(limitRegistrationSchema.safeParse({ rounds: 100, maxFailureRate: 0.5 }).success).toBe(
      true,
    )
    expect(limitRegistrationSchema.safeParse({ rounds: 2, maxFailureRate: 1 }).success).toBe(true)
  })

  it.each([
    { rounds: 0, maxFailureRate: 0 },
    { rounds: 101, maxFailureRate: 0 },
    { rounds: 2.5, maxFailureRate: 0 },
    { rounds: 2, maxFailureRate: -0.01 },
    { rounds: 2, maxFailureRate: 1.01 },
    { rounds: 2, maxFailureRate: Number.POSITIVE_INFINITY },
  ])('rejects the out-of-range limits %o', (limits) => {
    expect(limitRegistrationSchema.safeParse(limits).success).toBe(false)
  })

  it('rejects unknown limit keys', () => {
    expect(pathsOf(limitRegistrationSchema, { rounds: 2, maxFailureRate: 0, extra: 1 })).toContain(
      '',
    )
  })

  it('accepts a zero target effect and rejects a negative one', () => {
    expect(
      targetRegistrationSchema.safeParse({
        metric: 'replay.deterministic_rate',
        direction: 'increase',
        minimumDetectableEffect: 0,
      }).success,
    ).toBe(true)
    expect(
      pathsOf(targetRegistrationSchema, {
        metric: 'replay.deterministic_rate',
        direction: 'increase',
        minimumDetectableEffect: -0.01,
      }),
    ).toContain('minimumDetectableEffect')
  })

  it('rejects an invalid target metric, direction and unknown keys', () => {
    expect(
      pathsOf(targetRegistrationSchema, {
        metric: 'Bad Metric',
        direction: 'increase',
        minimumDetectableEffect: 0,
      }),
    ).toContain('metric')
    expect(
      pathsOf(targetRegistrationSchema, {
        metric: 'replay.deterministic_rate',
        direction: 'up',
        minimumDetectableEffect: 0,
      }),
    ).toContain('direction')
    expect(
      pathsOf(targetRegistrationSchema, {
        metric: 'replay.deterministic_rate',
        direction: 'increase',
        minimumDetectableEffect: 0,
        extra: true,
      }),
    ).toContain('')
  })

  it('accepts a zero tolerance and rejects a negative or non-finite one', () => {
    expect(
      guardrailRegistrationSchema.safeParse({
        metric: 'transcript.guard_violations',
        direction: 'decrease',
        tolerance: 0,
      }).success,
    ).toBe(true)
    expect(
      pathsOf(guardrailRegistrationSchema, {
        metric: 'transcript.guard_violations',
        direction: 'decrease',
        tolerance: -1,
      }),
    ).toContain('tolerance')
    expect(
      pathsOf(guardrailRegistrationSchema, {
        metric: 'transcript.guard_violations',
        direction: 'decrease',
        tolerance: Number.POSITIVE_INFINITY,
      }),
    ).toContain('tolerance')
  })
})

describe('baseline reference fields', () => {
  const runId = 'm0-canned-replay-bootstrap'
  const digest = 'a'.repeat(64)

  it('accepts metrics with and without a manifest digest', () => {
    expect(
      baselineReferenceSchema.safeParse({
        runId,
        metrics: { 'replay.deterministic_rate': 1 },
      }).success,
    ).toBe(true)
    expect(
      baselineReferenceSchema.safeParse({
        runId,
        manifestHash: digest,
        metrics: { 'replay.deterministic_rate': 1 },
      }).success,
    ).toBe(true)
  })

  it('requires at least one baseline metric axis', () => {
    expect(customIssue(baselineReferenceSchema, { runId, metrics: {} }, 'metrics')).toEqual({
      code: 'custom',
      path: 'metrics',
      message: 'baseline metrics must name at least one axis',
    })
  })

  it.each(['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)])(
    'rejects the manifest digest %s',
    (manifestHash) => {
      expect(
        pathsOf(baselineReferenceSchema, {
          runId,
          manifestHash,
          metrics: { 'replay.deterministic_rate': 1 },
        }),
      ).toContain('manifestHash')
    },
  )

  it('states the digest rule', () => {
    expect(
      messagesAt(
        baselineReferenceSchema,
        { runId, manifestHash: 'nope', metrics: { 'replay.deterministic_rate': 1 } },
        'manifestHash',
      ),
    ).toEqual(['must be a lowercase SHA-256 hex digest'])
  })

  it('rejects an invalid metric key, a non-finite value, an unsafe run id and unknown keys', () => {
    expect(pathsOf(baselineReferenceSchema, { runId, metrics: { 'Bad Metric': 1 } })).toContain(
      'metrics.Bad Metric',
    )
    expect(
      pathsOf(baselineReferenceSchema, {
        runId,
        metrics: { 'replay.deterministic_rate': Number.POSITIVE_INFINITY },
      }),
    ).toContain('metrics.replay.deterministic_rate')
    expect(pathsOf(baselineReferenceSchema, { runId: '-baseline', metrics: { a: 1 } })).toContain(
      'runId',
    )
    expect(
      pathsOf(baselineReferenceSchema, {
        runId,
        metrics: { a: 1 },
        extra: true,
      }),
    ).toContain('')
  })
})

describe('provider registration fields', () => {
  it('accepts a canned provider without live opt-in', () => {
    expect(
      providerRegistrationSchema.safeParse({
        mode: 'canned',
        label: 'm0-task-persona-v1',
        allowLive: false,
      }).success,
    ).toBe(true)
  })

  it('accepts a live provider with explicit opt-in and pacing', () => {
    expect(
      providerRegistrationSchema.safeParse({
        mode: 'live',
        label: 'gemma-live',
        allowLive: true,
        paceMs: 0,
      }).success,
    ).toBe(true)
  })

  it('rejects a live provider without explicit opt-in', () => {
    expect(
      customIssue(
        providerRegistrationSchema,
        { mode: 'live', label: 'gemma-live', allowLive: false },
        'allowLive',
      ),
    ).toEqual({
      code: 'custom',
      path: 'allowLive',
      message: 'live provider requires allowLive: true (explicit manifest opt-in)',
    })
  })

  it.each([-1, 1.5])('rejects the pace %s', (paceMs) => {
    expect(
      pathsOf(providerRegistrationSchema, {
        mode: 'canned',
        label: 'canned',
        allowLive: false,
        paceMs,
      }),
    ).toContain('paceMs')
  })

  it('rejects an empty label, an unknown mode and unknown keys', () => {
    expect(
      pathsOf(providerRegistrationSchema, { mode: 'canned', label: '', allowLive: false }),
    ).toContain('label')
    expect(
      pathsOf(providerRegistrationSchema, { mode: 'replay', label: 'x', allowLive: false }),
    ).toContain('mode')
    expect(
      pathsOf(providerRegistrationSchema, {
        mode: 'canned',
        label: 'x',
        allowLive: false,
        extra: true,
      }),
    ).toContain('')
  })
})

describe('prompt registration fields', () => {
  it('accepts a full persona prompt registration', () => {
    expect(
      promptRegistrationSchema.safeParse({
        version: 'm2-prompt-v2',
        mode: 'persona',
        style: 'harmony',
        currentDate: '2026-11-08',
        parameters: {
          temperature: 0.6,
          topP: 0.95,
          maxCompletionTokens: 512,
          reasoningEffort: 'medium',
          includeReasoning: false,
        },
      }).success,
    ).toBe(true)
  })

  it('accepts a generic gemma prompt without parameters', () => {
    expect(
      promptRegistrationSchema.safeParse({
        mode: 'generic',
        style: 'gemma',
        currentDate: '2026-11-08',
      }).success,
    ).toBe(true)
  })

  it('accepts the parameter boundaries and rejects out-of-range values', () => {
    expect(
      promptRegistrationSchema.safeParse({
        currentDate: '2026-11-08',
        parameters: { temperature: 0, topP: 0, maxCompletionTokens: 1, includeReasoning: true },
      }).success,
    ).toBe(true)
    expect(
      promptRegistrationSchema.safeParse({
        currentDate: '2026-11-08',
        parameters: { temperature: 2, topP: 1 },
      }).success,
    ).toBe(true)

    expect(
      pathsOf(promptRegistrationSchema, {
        currentDate: '2026-11-08',
        parameters: { temperature: 2.01 },
      }),
    ).toContain('parameters.temperature')
    expect(
      pathsOf(promptRegistrationSchema, {
        currentDate: '2026-11-08',
        parameters: { temperature: -0.01 },
      }),
    ).toContain('parameters.temperature')
    expect(
      pathsOf(promptRegistrationSchema, {
        currentDate: '2026-11-08',
        parameters: { topP: 1.01 },
      }),
    ).toContain('parameters.topP')
    expect(
      pathsOf(promptRegistrationSchema, {
        currentDate: '2026-11-08',
        parameters: { topP: -0.01 },
      }),
    ).toContain('parameters.topP')
    expect(
      pathsOf(promptRegistrationSchema, {
        currentDate: '2026-11-08',
        parameters: { maxCompletionTokens: 0 },
      }),
    ).toContain('parameters.maxCompletionTokens')
    expect(
      pathsOf(promptRegistrationSchema, {
        currentDate: '2026-11-08',
        parameters: { maxCompletionTokens: 1.5 },
      }),
    ).toContain('parameters.maxCompletionTokens')
  })

  it.each(['low', 'medium', 'high'])('accepts the %s reasoning effort', (reasoningEffort) => {
    expect(
      promptRegistrationSchema.safeParse({
        currentDate: '2026-11-08',
        parameters: { reasoningEffort },
      }).success,
    ).toBe(true)
  })

  it('rejects an unknown reasoning effort and an unknown parameter key', () => {
    expect(
      pathsOf(promptRegistrationSchema, {
        currentDate: '2026-11-08',
        parameters: { reasoningEffort: 'max' },
      }),
    ).toContain('parameters.reasoningEffort')
    expect(
      pathsOf(promptRegistrationSchema, {
        currentDate: '2026-11-08',
        parameters: { temperature: 0.6, extra: true },
      }),
    ).toContain('parameters')
  })

  it('requires a calendar date', () => {
    expect(pathsOf(promptRegistrationSchema, {})).toContain('currentDate')
    expect(pathsOf(promptRegistrationSchema, { currentDate: '2026-13-01' })).toContain(
      'currentDate',
    )
    expect(pathsOf(promptRegistrationSchema, { currentDate: '2026-11-8' })).toContain('currentDate')
  })

  it('rejects an empty version, an unknown mode/style and unknown keys', () => {
    expect(pathsOf(promptRegistrationSchema, { currentDate: '2026-11-08', version: '' })).toContain(
      'version',
    )
    expect(
      pathsOf(promptRegistrationSchema, { currentDate: '2026-11-08', mode: 'baseline' }),
    ).toContain('mode')
    expect(
      pathsOf(promptRegistrationSchema, { currentDate: '2026-11-08', style: 'gemini' }),
    ).toContain('style')
    expect(pathsOf(promptRegistrationSchema, { currentDate: '2026-11-08', extra: true })).toContain(
      '',
    )
  })
})

describe('multi-persona policy field', () => {
  it.each(['det-persona', 'fixed-rotation'])('accepts the %s policy', (policy) => {
    expect(multiPersonaRegistrationSchema.safeParse({ policy }).success).toBe(true)
  })

  it('rejects an unknown policy and unknown keys', () => {
    expect(pathsOf(multiPersonaRegistrationSchema, { policy: 'jev-persona' })).toContain('policy')
    expect(
      pathsOf(multiPersonaRegistrationSchema, { policy: 'det-persona', extra: true }),
    ).toContain('')
  })
})

// ---------------------------------------------------------------------------
// Whole-manifest fields, refinements, and issue rendering
// ---------------------------------------------------------------------------

describe('manifest version and cross-field refinements', () => {
  it('pins the schema version', () => {
    expect(MANIFEST_SCHEMA_VERSION).toBe('3.0.0')
    expect(parseManifest(loadExample()).schemaVersion).toBe('3.0.0')

    const raw = loadExample()
    raw['schemaVersion'] = '2.0.0'
    expect(manifestIssue(raw, 'schemaVersion').message).toMatch(/^schemaVersion: /)
  })

  it('rejects duplicate guardrail metrics with a field-named message', () => {
    const raw = loadExample()
    const guardrails = raw['guardrails'] as Record<string, unknown>[]
    guardrails.push({ metric: 'transcript.guard_violations', direction: 'decrease', tolerance: 0 })

    expect(manifestIssue(raw, 'guardrails')).toEqual({
      path: 'guardrails',
      message: 'guardrails: guardrail metrics must be unique; each axis is reported once',
    })
  })

  it('rejects a target metric that is also a guardrail', () => {
    const raw = loadExample()
    const guards = raw['guardrails'] as Record<string, unknown>[]
    guards.push({ metric: 'replay.deterministic_rate', direction: 'increase', tolerance: 0 })

    expect(manifestIssue(raw, 'target.metric')).toEqual({
      path: 'target.metric',
      message:
        'target.metric: target metric "replay.deterministic_rate" is also registered as a guardrail',
    })
  })

  it('rejects duplicate invariants', () => {
    const raw = loadExample()
    raw['invariants'] = ['transcript.schema_valid', 'transcript.schema_valid']

    expect(manifestIssue(raw, 'invariants')).toEqual({
      path: 'invariants',
      message: 'invariants: invariants must not repeat',
    })
  })

  it('requires a zero minimum detectable effect for a regression eval', () => {
    const raw = loadExample()
    ;(raw['target'] as Record<string, unknown>)['minimumDetectableEffect'] = 0.01

    expect(manifestIssue(raw, 'target.minimumDetectableEffect')).toEqual({
      path: 'target.minimumDetectableEffect',
      message:
        'target.minimumDetectableEffect: a regression eval holds its primary axis at the baseline; set minimumDetectableEffect to 0',
    })
  })

  it('requires a positive minimum detectable effect for a capability eval', () => {
    const raw = loadExample()
    ;(raw['run'] as Record<string, unknown>)['purpose'] = 'capability'
    ;(raw['target'] as Record<string, unknown>)['minimumDetectableEffect'] = 0

    expect(manifestIssue(raw, 'target.minimumDetectableEffect')).toEqual({
      path: 'target.minimumDetectableEffect',
      message:
        'target.minimumDetectableEffect: a capability eval must show a real improvement; set minimumDetectableEffect above 0',
    })

    const negative = loadExample()
    ;(negative['run'] as Record<string, unknown>)['purpose'] = 'capability'
    ;(negative['target'] as Record<string, unknown>)['minimumDetectableEffect'] = -0.01
    expect(pathsOfManifest(negative)).toContain('target.minimumDetectableEffect')
  })

  it('requires at least one guardrail and one invariant', () => {
    const noGuardrails = loadExample()
    noGuardrails['guardrails'] = []
    expect(pathsOfManifest(noGuardrails)).toContain('guardrails')

    const noInvariants = loadExample()
    noInvariants['invariants'] = []
    expect(pathsOfManifest(noInvariants)).toContain('invariants')
  })

  it('declares each manifest-level refinement as a custom issue', () => {
    const duplicateGuardrails = loadExample()
    ;(duplicateGuardrails['guardrails'] as Record<string, unknown>[]).push({
      metric: 'transcript.guard_violations',
      direction: 'decrease',
      tolerance: 0,
    })
    expect(customIssue(runManifestSchema, duplicateGuardrails, 'guardrails')).toEqual({
      code: 'custom',
      path: 'guardrails',
      message: 'guardrail metrics must be unique; each axis is reported once',
    })

    const targetGuardrail = loadExample()
    ;(targetGuardrail['guardrails'] as Record<string, unknown>[]).push({
      metric: 'replay.deterministic_rate',
      direction: 'increase',
      tolerance: 0,
    })
    expect(customIssue(runManifestSchema, targetGuardrail, 'target.metric')).toEqual({
      code: 'custom',
      path: 'target.metric',
      message: 'target metric "replay.deterministic_rate" is also registered as a guardrail',
    })

    const duplicateInvariants = loadExample()
    duplicateInvariants['invariants'] = ['transcript.schema_valid', 'transcript.schema_valid']
    expect(customIssue(runManifestSchema, duplicateInvariants, 'invariants')).toEqual({
      code: 'custom',
      path: 'invariants',
      message: 'invariants must not repeat',
    })

    const regressionEffect = loadExample()
    ;(regressionEffect['target'] as Record<string, unknown>)['minimumDetectableEffect'] = 0.01
    expect(
      customIssue(runManifestSchema, regressionEffect, 'target.minimumDetectableEffect'),
    ).toEqual({
      code: 'custom',
      path: 'target.minimumDetectableEffect',
      message:
        'a regression eval holds its primary axis at the baseline; set minimumDetectableEffect to 0',
    })

    const capabilityEffect = loadExample()
    ;(capabilityEffect['run'] as Record<string, unknown>)['purpose'] = 'capability'
    ;(capabilityEffect['target'] as Record<string, unknown>)['minimumDetectableEffect'] = 0
    expect(
      customIssue(runManifestSchema, capabilityEffect, 'target.minimumDetectableEffect'),
    ).toEqual({
      code: 'custom',
      path: 'target.minimumDetectableEffect',
      message:
        'a capability eval must show a real improvement; set minimumDetectableEffect above 0',
    })
  })
})

describe('manifest issue rendering', () => {
  it('labels an unrecognized root key with <root>', () => {
    const raw = loadExample()
    raw['extraField'] = true

    expect(manifestIssue(raw, '<root>')).toEqual({
      path: '<root>',
      message: 'unrecognized field(s): extraField',
    })
  })

  it('joins several unrecognized keys with a comma', () => {
    const raw = loadExample()
    raw['alpha'] = 1
    raw['beta'] = 2

    expect(manifestIssue(raw, '<root>')).toEqual({
      path: '<root>',
      message: 'unrecognized field(s): alpha, beta',
    })
  })

  it('labels an unrecognized nested key with its object path', () => {
    const raw = loadExample()
    ;(raw['provider'] as Record<string, unknown>)['extraField'] = true

    expect(manifestIssue(raw, 'provider')).toEqual({
      path: 'provider',
      message: 'provider: unrecognized field(s): extraField',
    })
  })

  it('does not call a root type error a missing field', () => {
    const result = validateManifest(undefined)
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.issues[0]?.path).toBe('<root>')
    expect(result.issues[0]?.message).not.toBe('missing required field')
  })

  it('renders nested fields and array indexes', () => {
    const badGuardrail = loadExample()
    ;(badGuardrail['guardrails'] as Record<string, unknown>[])[0] = {
      metric: 'transcript.schema_valid_rate',
      direction: 'up',
      tolerance: 0,
    }
    expect(manifestIssue(badGuardrail, 'guardrails[0].direction').message).toMatch(
      /^guardrails\[0\]\.direction: /,
    )

    const badParameter = loadExample()
    badParameter['prompt'] = { currentDate: '2026-11-08', parameters: { temperature: 3 } }
    expect(manifestIssue(badParameter, 'prompt.parameters.temperature').message).toMatch(
      /^prompt\.parameters\.temperature: /,
    )

    const badTaskId = loadExample()
    ;(badTaskId['tasks'] as Record<string, unknown>)['ids'] = ['task-ok', '']
    expect(manifestIssue(badTaskId, 'tasks.ids[1]').message).toMatch(/^tasks\.ids\[1\]: /)
  })

  it('formats one issue as its message only', () => {
    expect(
      formatManifestIssue({ path: 'limits.rounds', message: 'limits.rounds: too small' }),
    ).toBe('limits.rounds: too small')
  })

  it('names the error and joins every issue once', () => {
    const error = new ManifestValidationError([
      { path: 'limits', message: 'limits: missing required field' },
      { path: 'rubric', message: 'rubric: missing required field' },
    ])

    expect(error.name).toBe('ManifestValidationError')
    expect(error.message).toBe(
      'invalid run manifest: limits: missing required field; rubric: missing required field',
    )
    expect(error.issues).toEqual([
      { path: 'limits', message: 'limits: missing required field' },
      { path: 'rubric', message: 'rubric: missing required field' },
    ])
  })
})

function pathsOfManifest(input: unknown): string[] {
  const result = validateManifest(input)
  if (result.ok) return []
  return result.issues.map((issue) => issue.path)
}
