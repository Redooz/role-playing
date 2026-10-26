import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { taskEntrySchema, goldenEntrySchema } from './schema.js'

/**
 * Generates the committed JSON Schemas in `evals/schemas/` from the Zod
 * definitions. Zod is the source of truth; the JSON files exist so editors,
 * CI steps, and non-TypeScript tooling can validate entries without importing
 * this package.
 *
 * Regenerate after changing `schema.ts`:
 *
 * ```sh
 * UPDATE_SCHEMAS=1 npx vitest run packages/eval-harness/src/tasks/schema.spec.ts
 * npx prettier --write evals/schemas
 * ```
 *
 * The drift test in `schema.spec.ts` compares the parsed committed files with
 * `expectedSchemas()`, so a stale schema cannot land in CI. Formatting is
 * Prettier's job; the test compares data, not whitespace.
 */

export const SCHEMA_FILES = {
  'task.schema.json': taskEntrySchema,
  'golden.schema.json': goldenEntrySchema,
} as const

/** File name → the value `z.toJSONSchema` produces for that schema. */
export function expectedSchemas(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(SCHEMA_FILES).map(
      ([fileName, schema]) => [fileName, z.toJSONSchema(schema)] as const,
    ),
  )
}

/** File name → serialized contents written by the generator. */
export function schemaFileContents(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(expectedSchemas()).map(
      ([fileName, schema]) => [fileName, `${JSON.stringify(schema, null, 2)}\n`] as const,
    ),
  )
}

/** Writes every generated schema into `targetDir`. Returns the absolute paths written. */
export async function writeSchemaFiles(targetDir: string): Promise<string[]> {
  await mkdir(targetDir, { recursive: true })
  const written: string[] = []
  for (const [fileName, contents] of Object.entries(schemaFileContents())) {
    const target = join(targetDir, fileName)
    await writeFile(target, contents, 'utf8')
    written.push(target)
  }
  return written
}
