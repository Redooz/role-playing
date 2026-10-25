import { describe, expect, it } from 'vitest'
import {
  TRACE_SCHEMA_VERSION,
  TRACE_SCHEMA_VERSION_POLICY,
  traceSchemaVersionSchema,
} from './version.js'

describe('trace schema versioning policy', () => {
  it('is a semantic version', () => {
    expect(traceSchemaVersionSchema.safeParse(TRACE_SCHEMA_VERSION).success).toBe(true)
  })

  it('bumps minor for additive changes and major for breaking changes', () => {
    expect(TRACE_SCHEMA_VERSION_POLICY.additiveChange).toBe('minor')
    expect(TRACE_SCHEMA_VERSION_POLICY.breakingChange).toBe('major')
  })

  it('requires a fixture migration note for a breaking change', () => {
    expect(TRACE_SCHEMA_VERSION_POLICY.breakingChangeRequiresFixtureMigrationNote).toBe(true)
    expect(TRACE_SCHEMA_VERSION_POLICY.fixtureMigrationNotePath).toMatch(/MIGRATIONS\.md$/)
  })
})
