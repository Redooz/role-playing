import { sha256Hex } from '@rp/shared'

/**
 * Stable identity for one *execution* of a suite (M0.1).
 *
 * `runId` names the suite and is reused by every run, so it cannot identify a
 * Langfuse experiment. The execution id adds the run start time and a short
 * digest of both fields, which makes it unique per execution while staying
 * readable and URL-safe.
 */
export function deriveExecutionId(runId: string, startedAt: string): string {
  if (runId === '') throw new TypeError('runId must not be empty')
  if (Number.isNaN(Date.parse(startedAt))) {
    throw new TypeError(`startedAt must be an ISO-8601 timestamp: ${startedAt}`)
  }

  const compact = startedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const digest = sha256Hex(`${runId}\u0000${startedAt}`).slice(0, 8)
  return `${runId}-${compact}-${digest}`
}
