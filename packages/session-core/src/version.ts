import { z } from 'zod'

/**
 * Current version of the session event and transcript schema.
 *
 * Versioning policy (M0 D2, Architecture Plan v5 §2.1/§3.2):
 * - **Additive change → minor bump** (`1.0.0` → `1.1.0`). New optional payload
 *   fields, new event types, and widened enums are additive: an existing transcript
 *   still parses, so old tasks and baselines stay readable. `1.1.0` added the
 *   `session.started` event and the optional `executionId` record field.
 * - **Breaking change → major bump** (`1.x.y` → `2.0.0`) **and** a task
 *   migration note. Removed or renamed events/fields, changed field meaning,
 *   new required fields, or narrowed enums break readers and therefore require
 *   a note at {@link TRANSCRIPT_SCHEMA_MIGRATION_NOTE_PATH} describing how stored
 *   tasks and baselines are migrated.
 *
 * Compare the version embedded in a transcript record with this constant before
 * replaying it: a different major version must be migrated first, never parsed
 * leniently.
 */
export const TRANSCRIPT_SCHEMA_VERSION = '1.1.0'

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
