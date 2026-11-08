import { describe, expect, it } from 'vitest'
import {
  CONTENT_CLASS_RULE_SINCE,
  TRANSCRIPT_SCHEMA_VERSION,
  TRANSCRIPT_SCHEMA_VERSION_POLICY,
  isTranscriptSchemaAtLeast,
  majorOfSchemaVersion,
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

describe('majorOfSchemaVersion', () => {
  it('returns the leading version number', () => {
    expect(majorOfSchemaVersion('1.2.0')).toBe(1)
    expect(majorOfSchemaVersion('2.0.0')).toBe(2)
    expect(majorOfSchemaVersion('10.0.0')).toBe(10)
  })

  it('rejects a non-version', () => {
    expect(() => majorOfSchemaVersion('v1')).toThrow(/invalid schema version/)
    expect(() => majorOfSchemaVersion('1.1')).toThrow(/invalid schema version/)
    expect(() => majorOfSchemaVersion('01.2.0')).toThrow(/invalid schema version/)
  })
})

describe('transcriptSchemaVersionSchema', () => {
  it('requires the whole dotted version', () => {
    for (const invalid of ['1.0.0x', 'x1.0.0', '1.0', 'v1.0.0']) {
      expect(transcriptSchemaVersionSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('accepts multiple digits in every position', () => {
    expect(transcriptSchemaVersionSchema.safeParse('11.1.10').success).toBe(true)
    expect(transcriptSchemaVersionSchema.safeParse('1.1.10').success).toBe(true)
  })

  it('rejects leading zeros so a version has one spelling', () => {
    expect(transcriptSchemaVersionSchema.safeParse('01.1.0').success).toBe(false)
    expect(transcriptSchemaVersionSchema.safeParse('1.01.0').success).toBe(false)
    expect(transcriptSchemaVersionSchema.safeParse('1.1.00').success).toBe(false)
  })
})

describe('isTranscriptSchemaAtLeast', () => {
  it('orders versions numerically, not lexically', () => {
    expect(isTranscriptSchemaAtLeast('1.0.0', CONTENT_CLASS_RULE_SINCE)).toBe(false)
    expect(isTranscriptSchemaAtLeast('1.1.0', CONTENT_CLASS_RULE_SINCE)).toBe(true)
    expect(isTranscriptSchemaAtLeast('1.2.0', CONTENT_CLASS_RULE_SINCE)).toBe(true)
    expect(isTranscriptSchemaAtLeast('1.10.0', '1.9.0')).toBe(true)
    expect(isTranscriptSchemaAtLeast('2.0.0', CONTENT_CLASS_RULE_SINCE)).toBe(true)
  })

  it('treats an invalid version as below every minimum', () => {
    expect(isTranscriptSchemaAtLeast('v1', CONTENT_CLASS_RULE_SINCE)).toBe(false)
    expect(isTranscriptSchemaAtLeast('1.1', CONTENT_CLASS_RULE_SINCE)).toBe(false)
    expect(isTranscriptSchemaAtLeast('1.2.0', '1.1')).toBe(false)
  })

  it('requires the whole dotted version', () => {
    expect(isTranscriptSchemaAtLeast('1.1.0x', '1.1.0')).toBe(false)
    expect(isTranscriptSchemaAtLeast('x1.1.0', '1.1.0')).toBe(false)
    expect(isTranscriptSchemaAtLeast('1.1.10', '1.1.9')).toBe(true)
    expect(isTranscriptSchemaAtLeast('01.1.0', '1.1.0')).toBe(false)
  })
})
