import { describe, expect, it } from 'vitest'
import {
  TRANSCRIPT_SCHEMA_VERSION,
  TRANSCRIPT_SCHEMA_VERSION_POLICY,
  transcriptSchemaVersionSchema,
} from './version.js'

describe('transcript schema versioning policy', () => {
  it('is a semantic version', () => {
    expect(transcriptSchemaVersionSchema.safeParse(TRANSCRIPT_SCHEMA_VERSION).success).toBe(true)
  })

  it('bumps minor for additive changes and major for breaking changes', () => {
    expect(TRANSCRIPT_SCHEMA_VERSION_POLICY.additiveChange).toBe('minor')
    expect(TRANSCRIPT_SCHEMA_VERSION_POLICY.breakingChange).toBe('major')
  })

  it('requires a task migration note for a breaking change', () => {
    expect(TRANSCRIPT_SCHEMA_VERSION_POLICY.breakingChangeRequiresTaskMigrationNote).toBe(true)
    expect(TRANSCRIPT_SCHEMA_VERSION_POLICY.taskMigrationNotePath).toMatch(/MIGRATIONS\.md$/)
  })
})
