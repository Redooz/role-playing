import { z } from 'zod'

/**
 * Current version of the session event and trace schema.
 *
 * Versioning policy (M0 D2, Architecture Plan v5 §2.1/§3.2):
 * - **Additive change → minor bump** (`1.0.0` → `1.1.0`). New optional payload
 *   fields, new event types, and widened enums are additive: an existing trace
 *   still parses, so old fixtures and baselines stay readable.
 * - **Breaking change → major bump** (`1.x.y` → `2.0.0`) **and** a fixture
 *   migration note. Removed or renamed events/fields, changed field meaning,
 *   new required fields, or narrowed enums break readers and therefore require
 *   a note at {@link TRACE_SCHEMA_MIGRATION_NOTE_PATH} describing how stored
 *   fixtures and baselines are migrated.
 *
 * Compare the version embedded in a trace record with this constant before
 * replaying it: a different major version must be migrated first, never parsed
 * leniently.
 */
export const TRACE_SCHEMA_VERSION = '1.0.0'

/**
 * Machine-readable form of the versioning policy above, so tools can assert it
 * instead of parsing prose.
 */
export const TRACE_SCHEMA_VERSION_POLICY = {
  /** Version component bumped by a backward-compatible schema addition. */
  additiveChange: 'minor',
  /** Version component bumped by a breaking schema change. */
  breakingChange: 'major',
  /** A major bump is incomplete until fixtures carry a migration note. */
  breakingChangeRequiresFixtureMigrationNote: true,
  /** Where that note must live (committed artifact, see M0 plan D2/D5). */
  fixtureMigrationNotePath: 'evals/fixtures/MIGRATIONS.md',
} as const

/** `MAJOR.MINOR.PATCH`, the only accepted `schemaVersion` shape. */
export const traceSchemaVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'expected a semantic version such as "1.0.0"')
