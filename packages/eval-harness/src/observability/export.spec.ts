import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  LANGFUSE_ARTIFACT_SCHEMA_VERSION,
  langfuseArtifactSchema,
  langfuseExportStatusSchema,
  parseLangfuseArtifact,
} from './export.js'

const validArtifact = {
  schemaVersion: '1.0.0',
  status: 'exported',
  executionId: 'm0-canned-replay-20261107T102030Z-cfe06eed',
  runId: 'm0-canned-replay',
  baseUrl: 'http://localhost:3000',
  experimentId: 'm0-canned-replay-20261107T102030Z-cfe06eed',
  experimentUrl: 'http://localhost:3000/project/experiments/one',
  traceIds: { '0:en:en-b1-report-deadline-001': 'trace-1' },
  exportedAt: '2026-11-07T10:20:30.000Z',
} as const

function issues(input: unknown): z.ZodIssue[] {
  const parsed = langfuseArtifactSchema.safeParse(input)
  if (parsed.success) throw new Error('expected the artifact to be rejected')
  return parsed.error.issues
}

function issuePaths(input: unknown): string[] {
  return issues(input).map((issue) =>
    issue.path.length === 0 ? '<root>' : issue.path.map(String).join('.'),
  )
}

describe('export sidecar schema', () => {
  it('keeps the published schema version', () => {
    expect(LANGFUSE_ARTIFACT_SCHEMA_VERSION).toBe('1.0.0')
  })

  it('accepts exactly the three export states', () => {
    expect(langfuseExportStatusSchema.options).toEqual(['disabled', 'exported', 'failed'])
  })

  it('parses a complete artifact without dropping or adding fields', () => {
    expect(parseLangfuseArtifact(validArtifact)).toStrictEqual(validArtifact)
  })

  it('accepts a minimal disabled artifact with no export detail', () => {
    const minimal = {
      schemaVersion: '1.0.0',
      status: 'disabled',
      executionId: 'execution-1',
      runId: 'suite',
      traceIds: {},
    } as const
    expect(parseLangfuseArtifact(minimal)).toStrictEqual(minimal)
  })

  it('accepts a failed artifact carrying the error and no experiment identity', () => {
    const failed = {
      schemaVersion: '1.0.0',
      status: 'failed',
      executionId: 'execution-1',
      runId: 'suite',
      baseUrl: 'http://localhost:3000',
      traceIds: {},
      error: 'connection refused',
    } as const
    expect(parseLangfuseArtifact(failed)).toStrictEqual(failed)
  })

  it.each(['disabled', 'exported', 'failed'] as const)('accepts the %s status', (status) => {
    const artifact = { ...validArtifact, status }
    expect(parseLangfuseArtifact(artifact).status).toBe(status)
  })

  it('rejects an unknown status', () => {
    const rejected = langfuseArtifactSchema.safeParse({ ...validArtifact, status: 'partial' })
    expect(rejected.success).toBe(false)
    if (rejected.success) return
    expect(rejected.error.issues.map((issue) => issue.path.join('.'))).toEqual(['status'])
  })

  it('rejects another schema version', () => {
    expect(issuePaths({ ...validArtifact, schemaVersion: '1.0.1' })).toEqual(['schemaVersion'])
  })

  it('rejects an artifact that is not an object', () => {
    expect(() => parseLangfuseArtifact(null)).toThrow(z.ZodError)
    expect(() => parseLangfuseArtifact('artifact')).toThrow(z.ZodError)
  })

  it('rejects unknown keys instead of silently dropping them', () => {
    expect(issuePaths({ ...validArtifact, verdict: 'accepted' })).toEqual(['<root>'])
  })

  it.each(['executionId', 'runId', 'traceIds', 'schemaVersion', 'status'] as const)(
    'requires %s',
    (key) => {
      const { [key]: _removed, ...without } = validArtifact
      expect(issuePaths(without)).toContain(key)
    },
  )

  it.each([
    ['executionId', ''],
    ['runId', ''],
    ['baseUrl', ''],
    ['experimentId', ''],
    ['experimentUrl', ''],
    ['error', ''],
  ] as const)('rejects an empty %s', (key, value) => {
    expect(issuePaths({ ...validArtifact, [key]: value })).toEqual([key])
  })

  it('rejects empty trace id keys and values', () => {
    expect(issuePaths({ ...validArtifact, traceIds: { '': 'trace-1' } })).toEqual(['traceIds.'])
    expect(issuePaths({ ...validArtifact, traceIds: { item: '' } })).toEqual(['traceIds.item'])
  })

  it('rejects a non-string trace id', () => {
    const rejected = langfuseArtifactSchema.safeParse({
      ...validArtifact,
      traceIds: { item: 7 },
    })
    expect(rejected.success).toBe(false)
  })

  it.each([
    ['2026-11-07T10:20:30Z'],
    ['2026-11-07T10:20:30.000+01:00'],
    ['2026-11-07T10:20:30.000-05:00'],
  ])('accepts the offset timestamp %s', (exportedAt) => {
    expect(parseLangfuseArtifact({ ...validArtifact, exportedAt }).exportedAt).toBe(exportedAt)
  })

  it.each([['2026-11-07'], ['2026-11-07T10:20:30'], ['yesterday'], ['']])(
    'rejects the non-offset timestamp %s',
    (exportedAt) => {
      expect(issuePaths({ ...validArtifact, exportedAt })).toEqual(['exportedAt'])
    },
  )

  it('rejects a traceIds value that is not a record', () => {
    expect(issuePaths({ ...validArtifact, traceIds: ['trace-1'] })).toEqual(['traceIds'])
  })
})
