import { z } from 'zod'

/**
 * `langfuse.json` sidecar (M0.1 D5).
 *
 * Export state lives outside `result.json` on purpose: the strict result schema
 * is the eval contract and must not change because a review platform was
 * unreachable. The artifact always exists so a reviewer can tell "export was
 * off" from "export failed" without reading CI logs.
 */

export const LANGFUSE_ARTIFACT_SCHEMA_VERSION = '1.0.0'

export const langfuseExportStatusSchema = z.enum(['disabled', 'exported', 'failed'])
export type LangfuseExportStatus = z.infer<typeof langfuseExportStatusSchema>

export const langfuseArtifactSchema = z.strictObject({
  schemaVersion: z.literal(LANGFUSE_ARTIFACT_SCHEMA_VERSION),
  status: langfuseExportStatusSchema,
  executionId: z.string().min(1),
  runId: z.string().min(1),
  baseUrl: z.string().min(1).optional(),
  experimentId: z.string().min(1).optional(),
  experimentUrl: z.string().min(1).optional(),
  /** Item id (`round:lang:taskId`) → platform trace id. */
  traceIds: z.record(z.string().min(1), z.string().min(1)),
  error: z.string().min(1).optional(),
  exportedAt: z.iso.datetime({ offset: true }).optional(),
})

export type LangfuseArtifact = z.infer<typeof langfuseArtifactSchema>

export function parseLangfuseArtifact(input: unknown): LangfuseArtifact {
  return langfuseArtifactSchema.parse(input)
}
