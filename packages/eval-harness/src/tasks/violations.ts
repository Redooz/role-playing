/**
 * Violation vocabulary for the task/golden validator (M0 D5, gate G3).
 *
 * The validator returns violations instead of throwing; these codes and the
 * rendered form are part of the CLI/CI contract, so they live in one module that
 * the tree walker and the per-entry rules share.
 */

/** Stable violation codes. The eval-harness CLI and CI output depend on these strings. */
export type ViolationCode =
  | 'EVALS_DIR_MISSING'
  | 'UNREADABLE_DIRECTORY'
  | 'UNREADABLE_FILE'
  | 'INVALID_JSON'
  | 'INVALID_LAYOUT'
  | 'SCHEMA_VIOLATION'
  | 'MISSING_PROVENANCE'
  | 'MISSING_CONSENT_SCOPE'
  | 'MISSING_ANNOTATION_VERSIONS'
  | 'LANG_PATH_MISMATCH'
  | 'LOCALE_PATH_MISMATCH'
  | 'DUPLICATE_ID'
  | 'SPLIT_LEAKAGE'
  | 'GOLDEN_AGREEMENT_MISSING'
  | 'GOLDEN_TASK_MISSING'
  | 'GOLDEN_TASK_SPLIT_MISMATCH'
  | 'GOLDEN_LOCALE_MISMATCH'
  | 'SESSION_REFERENCE_MISSING'
  | 'SESSION_VERSION_MISMATCH'
  | 'SESSION_LOCALE_MISSING'
  | 'SESSION_PERSONA_MISMATCH'
  | 'ROUTING_PERSONA_UNKNOWN'
  | 'ROUTING_LABEL_INVALID'
  | 'ROUTING_LABEL_MISSING'
  | 'SPEAKER_LABEL_INVALID'
  | 'COMPOSITION_MISSING'
  | 'INVALID_COMPOSITION'
  | 'COMPOSITION_MISMATCH'
  | 'COMPOSITION_ONE_SIDED'
  | 'COMPOSITION_FAMILY'
  | 'COMPOSITION_DISTRACTOR'

export interface TaskViolation {
  /** Path relative to `rootDir`, always with `/` separators. */
  path: string
  code: ViolationCode
  message: string
}

/** Convenience for CLI output; not used by the validator itself. */
export function formatViolation(violation: TaskViolation): string {
  return `${violation.path}: [${violation.code}] ${violation.message}`
}

/** Render a Zod issue path (`['content', 'turns', 0]`) as `content.turns[0]`. */
export function renderFieldPath(path: readonly PropertyKey[]): string {
  let rendered = ''
  for (const segment of path) {
    if (typeof segment === 'number') {
      rendered += `[${segment}]`
    } else if (rendered === '') {
      rendered = String(segment)
    } else {
      rendered += `.${String(segment)}`
    }
  }
  return rendered === '' ? '<root>' : rendered
}

/** Turn schema issues into one `SCHEMA_VIOLATION` per failing field. */
export function pushSchemaViolations(
  violations: TaskViolation[],
  path: string,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): void {
  for (const issue of issues) {
    const field = renderFieldPath(issue.path)
    violations.push({
      path,
      code: 'SCHEMA_VIOLATION',
      message: `${field}: ${issue.message}`,
    })
  }
}
