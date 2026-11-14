/**
 * Shared builders for the task/golden validator specs.
 *
 * Test-only: it writes throwaway trees and task entries so the walking,
 * reference, golden-link and index-rule specs all describe the same fixtures.
 * It is excluded from mutation (`*.fixtures.ts`), like the routing-policy and
 * turn-arbiter fixtures.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RoutingContext } from '@rp/routing-policy'
import type { GoldenEntry, TaskEntry } from './schema.js'

const tempDirs: string[] = []

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

/** Writes the given `relative path -> JSON value` map into a fresh temp tree. */
export async function makeTree(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rp-eval-tree-'))
  tempDirs.push(root)
  for (const [relativePath, value] of Object.entries(files)) {
    const target = join(root, relativePath)
    await mkdir(dirname(target), { recursive: true })
    const contents = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    await writeFile(target, contents, 'utf8')
  }
  return root
}

export function taskPath(
  lang: 'en' | 'fr',
  name: string,
  dataset = 'synthetic-workplace',
  version = 'v1',
): string {
  return `evals/tasks/${dataset}/${version}/${lang}/${name}.json`
}

export function goldenPath(lang: 'en' | 'fr', name: string): string {
  return `evals/golden/${lang}/v1/${name}.json`
}

export function taskEntry(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: 'task-001',
    lang: 'en',
    mode: 'replay',
    domain: 'workplace',
    scenarioType: 'request-deadline-extension',
    cefrBand: 'B1',
    speakerId: 'speaker-001',
    split: 'calibration',
    provenance: { source: 'synthetic' },
    consentScope: 'synthetic-no-consent-required',
    annotationVersions: { rubric: 'v1' },
    content: {
      scenarioBrief: 'A learner asks a manager for more time.',
      turns: [
        { role: 'persona', text: 'How is it going?' },
        { role: 'user', text: 'Could I have two more days?' },
      ],
    },
    ...overrides,
  }
}

export function goldenEntry(overrides: Partial<GoldenEntry> = {}): GoldenEntry {
  return {
    id: 'golden-001',
    lang: 'en',
    split: 'calibration',
    routingLabels: { intent: 'request-deadline-extension', expectedPersonaId: 'persona-manager' },
    dimensionScores: { clarity: { score: 4 } },
    evidenceSpans: [{ turnIndex: 1, textRef: 'two more days' }],
    pairwisePreferences: [],
    status: 'draft',
    ...overrides,
  }
}

export const routingContext: RoutingContext = {
  decisionId: 'routing-001',
  turnId: 'turn-001',
  lang: 'en',
  transcript: [
    { speaker: { kind: 'persona', personaId: 'manager' }, text: 'We need a date.' },
    { speaker: { kind: 'user' }, text: 'Sam, can you confirm the handoff?' },
  ],
  personas: [
    {
      id: 'manager',
      displayName: 'Katherine Brooks',
      aliases: ['Katherine'],
      role: 'manager',
      objectives: [{ id: 'deadline', description: 'Agree a deadline.', keywords: ['deadline'] }],
    },
    {
      id: 'peer',
      displayName: 'Sam Carter',
      aliases: ['Sam'],
      role: 'peer colleague',
      objectives: [{ id: 'handoff', description: 'Confirm handoff.', keywords: ['handoff'] }],
    },
  ],
  coveredObjectiveIds: [],
}

export function routingTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return taskEntry({
    id: 'routing-001',
    mode: 'routing',
    content: { scenarioBrief: 'A routing decision.', turns: [] },
    routing: { context: routingContext },
    ...overrides,
  })
}

export function routingGolden(overrides: Partial<GoldenEntry> = {}): GoldenEntry {
  return goldenEntry({
    taskId: 'routing-001',
    routingLabels: undefined,
    dimensionScores: undefined,
    routingOutcome: {
      intent: 'confirm-handoff',
      acceptablePersonaIds: ['peer'],
      allowUserYield: false,
      labelSource: 'agent',
    },
    ...overrides,
  })
}
