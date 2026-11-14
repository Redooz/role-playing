import type { Grader, ObserverFactory, ProviderFactory } from '@rp/eval-harness'

/**
 * The ports the eval-harness CLI takes from its caller.
 *
 * Output goes through `CliIo` so tests capture it instead of stdout; every
 * injectable dependency defaults in `main` and is overridden only by tests.
 */

export interface CliIo {
  out(line: string): void
  err(line: string): void
}

export interface CliDeps {
  /** Override the repository root (tests). */
  repoRoot?: string
  /** Override wall-clock metadata (tests). */
  wallClock?: () => number
  /** Override the code SHA stamp (tests). */
  codeSha?: string
  /** Environment for the Langfuse export step (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Replace the Langfuse adapter in tests; never loaded unless export is on. */
  observerFactory?: ObserverFactory
  /** Override the provider factory (tests). */
  providerFactory?: ProviderFactory
  /** Override the semantic grader (tests). */
  grader?: Grader
}
