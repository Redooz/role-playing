import { createCannedProvider, createLiveProvider } from './canned-provider.js'
import { HarnessConfigError } from './errors.js'
import type { RunManifest } from './manifest.js'
import { buildCannedEntriesForTask } from './replay.js'
import {
  GENERIC_PROMPT_TEMPLATE_VERSION,
  SESSION_PROMPT_TEMPLATE_VERSIONS,
  buildSessionCannedEntries,
} from './session-runner.js'
import type { LoadedTask } from './task-loader.js'
import type { ProviderFactory } from './trial.js'
import type { Grader } from './grader.js'

/**
 * Run configuration guards.
 *
 * Rejects a manifest, grader or provider combination the run cannot honour
 * before any trial starts, and builds the provider factory the trials share.
 * Every rejection is a `HarnessConfigError`, never a failed measurement.
 */

/** A grader must match the grader, kind and rubric the manifest pre-registered. */
export function assertGraderMatchesManifest(grader: Grader, manifest: RunManifest): void {
  if (
    grader.id !== manifest.grader.id ||
    grader.kind !== manifest.grader.kind ||
    grader.version !== manifest.grader.version
  ) {
    throw new HarnessConfigError(
      `grader mismatch: manifest registers "${manifest.grader.id}" (${manifest.grader.kind}) version "${manifest.grader.version}" but the injected grader is "${grader.id}" (${grader.kind}) version "${grader.version}"`,
    )
  }
  if (grader.kind === 'system-one-model' && grader.rubricVersion === undefined) {
    throw new HarnessConfigError(
      `grader "${grader.id}" is a system-one-model grader but declares no rubric; the manifest's rubric cannot be checked`,
    )
  }
  if (grader.rubricVersion !== undefined && grader.rubricVersion !== manifest.rubric.version) {
    throw new HarnessConfigError(
      `rubric mismatch: manifest registers rubric "${manifest.rubric.version}" but grader "${grader.id}" implements "${grader.rubricVersion}"`,
    )
  }
}

/** A session task needs a pinned prompt date and a registered multi-persona policy. */
export function assertSessionPrompt(manifest: RunManifest, tasks: readonly LoadedTask[]): void {
  const sessionTasks = tasks.filter(({ task }) => task.mode === 'session')
  if (sessionTasks.length === 0) return

  const prompt = manifest.prompt
  if (prompt === undefined) {
    throw new HarnessConfigError(
      'a manifest selecting session tasks must register prompt.currentDate so the prompt is reproducible',
    )
  }
  if (prompt.version !== undefined) {
    const style = prompt.style ?? 'harmony'
    const expected =
      prompt.mode === 'generic'
        ? GENERIC_PROMPT_TEMPLATE_VERSION
        : SESSION_PROMPT_TEMPLATE_VERSIONS[style]
    if (prompt.version !== expected) {
      throw new HarnessConfigError(
        `manifest prompt version "${prompt.version}" does not match the ${prompt.mode ?? 'persona'} template "${expected}"`,
      )
    }
  }
  for (const { task } of sessionTasks) {
    if (task.session === undefined) {
      throw new HarnessConfigError(`session task ${task.id} has no session block`)
    }
    if ((task.session.personaIds?.length ?? 1) > 1 && manifest.multiPersona === undefined) {
      throw new HarnessConfigError(
        `multi-persona session task ${task.id} requires a registered multiPersona policy`,
      )
    }
  }
}

/** Build the per-trial provider factory from the manifest's provider mode. */
export function createProviderFactory(
  manifest: RunManifest,
  tasks: readonly LoadedTask[],
): ProviderFactory {
  if (manifest.provider.mode === 'live') {
    return () => createLiveProvider(manifest.provider.label)
  }

  const currentDate = manifest.prompt?.currentDate
  const style = manifest.prompt?.style ?? 'harmony'
  const entries = tasks.flatMap(({ task }) => {
    if (task.mode === 'session') {
      if (currentDate === undefined) {
        throw new HarnessConfigError(
          `canned session replay for ${task.id} requires manifest.prompt.currentDate`,
        )
      }
      return buildSessionCannedEntries(task, currentDate, style, manifest.prompt?.mode ?? 'persona')
    }
    return buildCannedEntriesForTask(task)
  })
  // Validate the recorded bundle once, before any trial runs. A bad bundle is a
  // configuration error, not a failed trial. Each trial still gets a fresh
  // provider instance.
  createCannedProvider(entries, manifest.provider.label)
  return () => createCannedProvider(entries, manifest.provider.label)
}
