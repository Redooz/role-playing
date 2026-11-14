/**
 * Runner error vocabulary.
 *
 * `HarnessConfigError` means the run cannot start because its configuration is
 * invalid; the eval-harness CLI maps it to exit code 2. It is never a failed
 * measurement, and never a "no".
 */
import type { ManifestIssue } from './manifest.js'

export class HarnessConfigError extends Error {
  readonly issues: readonly ManifestIssue[]

  constructor(message: string, issues: readonly ManifestIssue[] = []) {
    super(message)
    this.name = 'HarnessConfigError'
    this.issues = issues
  }
}

/** Render an unknown thrown value without losing its message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
