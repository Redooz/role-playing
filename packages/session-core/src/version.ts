import { z } from 'zod'

/**
 * Current version of the session event and transcript schema.
 *
 * Versioning policy (M0 D2, Architecture Plan v5 §2.1/§3.2):
 * - **Additive change → minor bump** (`1.0.0` → `1.1.0`). New optional payload
 *   fields, new event types, and widened enums are additive: an existing transcript
 *   still parses, so old tasks and baselines stay readable. `1.1.0` added the
 *   `session.started` event, the optional `executionId` record field, and the
 *   content-class rule; `1.2.0` added optional `usage` to
 *   `persona.response.committed`.
 * - **Breaking change → major bump** (`1.x.y` → `2.0.0`) **and** a task
 *   migration note. Removed or renamed events/fields, changed field meaning,
 *   new required fields, or narrowed enums break readers and therefore require
 *   a note at
 *   {@link TRANSCRIPT_SCHEMA_VERSION_POLICY.taskMigrationNotePath} describing how
 *   stored tasks and baselines are migrated.
 *
 * Compare the version embedded in a transcript record with this constant before
 * replaying it: a different major version must be migrated first, never parsed
 * leniently.
 */
export const TRANSCRIPT_SCHEMA_VERSION = '1.2.0'

/**
 * First schema version whose records must satisfy the structural content-class
 * rule in `transcriptRecordSchema`.
 *
 * The rule was added in `1.1.0`. Enforcing it on `1.0.0` records too would make a
 * minor bump behave like a breaking one: a `1.0.0` log that stored an
 * operational event as `public` was legal then and must stay readable. New
 * producers always write the current version, so every new record is checked.
 */
export const CONTENT_CLASS_RULE_SINCE = '1.1.0'

function parseSchemaVersion(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** The leading number of a `MAJOR.MINOR.PATCH` version. Throws on a non-version. */
export function majorOfSchemaVersion(version: string): number {
  const parsed = parseSchemaVersion(version)
  if (parsed === undefined) throw new TypeError(`invalid schema version "${version}"`)
  return parsed[0] as number
}

/**
 * Compare a schema version against a minimum. Invalid versions compare as
 * `false`; the base envelope schema rejects them before a refinement runs.
 */
export function isTranscriptSchemaAtLeast(version: string, minimum: string): boolean {
  const actual = parseSchemaVersion(version)
  const floor = parseSchemaVersion(minimum)
  if (actual === undefined || floor === undefined) return false

  for (let index = 0; index < actual.length; index += 1) {
    const a = actual[index] as number
    const b = floor[index] as number
    if (a !== b) return a > b
  }
  return true
}

/**
 * Machine-readable form of the versioning policy above, so tools can assert it
 * instead of parsing prose.
 */
export const TRANSCRIPT_SCHEMA_VERSION_POLICY = {
  /** Version component bumped by a backward-compatible schema addition. */
  additiveChange: 'minor',
  /** Version component bumped by a breaking schema change. */
  breakingChange: 'major',
  /** A major bump is incomplete until tasks carry a migration note. */
  breakingChangeRequiresTaskMigrationNote: true,
  /** Where that note must live (committed artifact, see M0 plan D2/D5). */
  taskMigrationNotePath: 'evals/tasks/MIGRATIONS.md',
} as const

/** `MAJOR.MINOR.PATCH`, the only accepted `schemaVersion` shape. */
export const transcriptSchemaVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'expected a semantic version such as "1.0.0"')
