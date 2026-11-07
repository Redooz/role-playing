import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LANGFUSE_ARTIFACT_SCHEMA_VERSION,
  ObservationPlanError,
  buildObservationPlan,
  goldenIndexByTask,
  loadGoldenEntries,
  type EvaluationObserver,
  type EvaluationRun,
  type GradesArtifact,
  type LangfuseArtifact,
  type ObserverConfig,
  type ObserverFactory,
} from '@rp/eval-harness'
import type { CliIo } from './cli-main.js'

/**
 * Langfuse export step (M0.1 D5).
 *
 * Runs *after* `result.json`, the transcripts and `grades.jsonl` are written.
 * It always writes `langfuse.json`; an export failure never changes the eval
 * verdict and never deletes evidence.
 */

export interface ExportRunOptions {
  readonly execution: EvaluationRun
  readonly grades: GradesArtifact
  readonly runDir: string
  readonly repoRoot: string
  readonly io: CliIo
  readonly env: NodeJS.ProcessEnv
  /** Injected by tests instead of loading the Langfuse adapter. */
  readonly observerFactory?: ObserverFactory
  readonly noExport: boolean
  readonly requireExport: boolean
}

/** Export one execution and return the artifact that was written. */
export async function exportRun(options: ExportRunOptions): Promise<LangfuseArtifact> {
  const { execution, grades, runDir, env, io } = options
  const enabled = options.requireExport || (isEnabled(env) && !options.noExport)

  let artifact: LangfuseArtifact = {
    schemaVersion: LANGFUSE_ARTIFACT_SCHEMA_VERSION,
    status: 'disabled',
    executionId: grades.executionId,
    runId: execution.result.runId,
    traceIds: {},
  }

  if (!enabled) {
    io.out('langfuse: export disabled (set LANGFUSE_ENABLED=true to export)')
    await writeArtifact(runDir, artifact)
    return artifact
  }

  let observer: EvaluationObserver | undefined

  try {
    const config = readConfig(env)
    artifact = { ...artifact, baseUrl: config.baseUrl }

    const factory =
      options.observerFactory ??
      (await import('./adapters/langfuse.adapter.js')).createLangfuseObserver
    observer = await factory(config)

    const golden = await loadGoldenEntries(options.repoRoot, {
      version: execution.result.manifest.tasks.version,
      languages: execution.result.manifest.tasks.languages,
    })
    const plan = buildObservationPlan({
      execution,
      grades: grades.records,
      executionId: grades.executionId,
      expectedOutputs: goldenIndexByTask(golden),
    })
    const receipt = await observer.observe(plan)

    const missing = plan.items
      .map((item) => item.itemId)
      .filter((itemId) => receipt.traceIds[itemId] === undefined)
    if (missing.length > 0) {
      throw new ObservationPlanError(
        `export returned no trace id for ${missing.length} item(s): ${missing.join(', ')}`,
      )
    }

    artifact = {
      ...artifact,
      status: 'exported',
      experimentId: receipt.experimentId,
      ...(receipt.experimentUrl === undefined ? {} : { experimentUrl: receipt.experimentUrl }),
      traceIds: { ...receipt.traceIds },
      exportedAt: new Date().toISOString(),
    }

    io.out(
      `langfuse: exported ${plan.items.length} item trace(s) to experiment ${receipt.experimentId}`,
    )
    if (receipt.experimentUrl !== undefined) io.out(`langfuse: ${receipt.experimentUrl}`)
  } catch (error) {
    artifact = {
      ...artifact,
      status: 'failed',
      error: errorMessage(error),
    }
    io.err(`langfuse: export failed: ${errorMessage(error)}`)
  } finally {
    if (observer !== undefined) {
      try {
        await observer.shutdown()
      } catch (error) {
        artifact = {
          ...artifact,
          status: 'failed',
          error: `langfuse shutdown failed: ${errorMessage(error)}`,
        }
        io.err(`langfuse: shutdown failed: ${errorMessage(error)}`)
      }
    }
  }

  await writeArtifact(runDir, artifact)
  return artifact
}

function isEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = (env['LANGFUSE_ENABLED'] ?? '').trim().toLowerCase()
  return value === 'true' || value === '1' || value === 'yes'
}

function readConfig(env: NodeJS.ProcessEnv): ObserverConfig {
  const baseUrl = (env['LANGFUSE_BASE_URL'] ?? '').trim()
  const publicKey = (env['LANGFUSE_PUBLIC_KEY'] ?? '').trim()
  const secretKey = (env['LANGFUSE_SECRET_KEY'] ?? '').trim()
  const projectId = (env['LANGFUSE_PROJECT_ID'] ?? '').trim()

  if (baseUrl === '') throw new Error('LANGFUSE_BASE_URL is not set')
  if (publicKey === '') throw new Error('LANGFUSE_PUBLIC_KEY is not set')
  if (secretKey === '') throw new Error('LANGFUSE_SECRET_KEY is not set')

  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error(`LANGFUSE_BASE_URL is not a valid URL: ${baseUrl}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`LANGFUSE_BASE_URL must be http(s): ${baseUrl}`)
  }

  if (url.hostname === 'langfuse.com' || url.hostname.endsWith('.langfuse.com')) {
    throw new Error('refusing Langfuse Cloud; the review layer is self-hosted only')
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    publicKey,
    secretKey,
    ...(projectId === '' ? {} : { projectId }),
  }
}

async function writeArtifact(runDir: string, artifact: LangfuseArtifact): Promise<void> {
  await writeFile(join(runDir, 'langfuse.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
