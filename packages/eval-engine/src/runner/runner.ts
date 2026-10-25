import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import {
  FakeClock,
  SystemClock,
  createSeededRandom,
  sha256Hex,
  type SeededRandom,
} from '@rp/shared'
import {
  checkTraceSequence,
  eventFromTraceRecord,
  guardTurnEvents,
  isSessionEventName,
  type SessionEvent,
  type Violation,
} from '@rp/session-core'
import { fixtureEntrySchema, type FixtureEntry, type Lang } from '../fixtures/schema.js'
import {
  CannedProviderMissError,
  ProviderUnavailableError,
  createCannedProvider,
  createLiveProvider,
  type CompletionProvider,
} from './canned-provider.js'
import {
  manifestHash,
  parseManifest,
  type FixtureSelection,
  type InvariantResult,
  type ManifestIssue,
  type RunManifest,
} from './manifest.js'
import {
  buildCannedEntriesForFixture,
  expectedContentClass,
  replayFixture,
  ReplayError,
} from './replay.js'
import {
  RUN_RESULT_SCHEMA_VERSION,
  buildVersions,
  metricReadingsSchema,
  parseRunResult,
  traceRelativePath,
  type MetricReadings,
  type RepetitionOutcome,
  type RunResult,
  type RunSummary,
} from './results.js'
import {
  createDeterministicInvariantScorer,
  type RunScorer,
  type TracedRepetition,
} from './scorer.js'
import { computeVerdict, type RunVerdict } from './verdict.js'

/**
 * Simulated-time eval runner (M0 D3).
 *
 * Executes the manifest's repetitions over the selected fixtures, using a fresh
 * `FakeClock` per fixture so simulated time always starts at zero. The runner
 * computes invariants itself, asks an injected scorer for per-axis metrics and
 * then asks the pure verdict function for the decision. It never infers a
 * verdict from feature code and never turns a failed repetition into a zero.
 *
 * File writing is deliberately left to the CLI: `executeRun` returns the result
 * artifact and the normalized traces in memory.
 */

export class RunnerConfigError extends Error {
  readonly issues: readonly ManifestIssue[]

  constructor(message: string, issues: readonly ManifestIssue[] = []) {
    super(message)
    this.name = 'RunnerConfigError'
    this.issues = issues
  }
}

export interface LoadedFixture {
  readonly fixture: FixtureEntry
  /** Path relative to the repository root, using `/` separators. */
  readonly relativePath: string
}

export interface ExecuteRunOptions {
  /** Repository root: the directory containing `evals/`. */
  readonly repoRoot: string
  /** Raw manifest (validated here) or an already-parsed manifest. */
  readonly manifest: unknown
  /** Scoring port. Defaults to the deterministic invariant scorer. */
  readonly scorer?: RunScorer
  /** Wall clock used only for run metadata and `tWall`. */
  readonly wallClock?: () => number
  /** Code SHA to stamp into the result, when the caller can resolve one. */
  readonly codeSha?: string
}

export interface RunTraceFile {
  readonly fixtureId: string
  readonly lang: Lang
  readonly repetition: number
  readonly relativePath: string
  readonly jsonl: string
  readonly sha256: string
}

export interface RunExecution {
  readonly result: RunResult
  readonly traces: readonly RunTraceFile[]
}

/**
 * Load and validate the fixtures selected by the manifest.
 *
 * Every file is parsed against `fixtureEntrySchema`; a malformed fixture is a
 * configuration error, not a failed measurement. Each requested language must
 * contribute at least one fixture (§4.4: passing EN does not count for FR).
 */
export async function loadSelectedFixtures(
  repoRoot: string,
  selection: FixtureSelection,
): Promise<LoadedFixture[]> {
  const root = resolve(repoRoot)
  const selected: LoadedFixture[] = []

  for (const lang of selection.languages) {
    const directory = join(root, 'evals', 'fixtures', selection.dataset, selection.version, lang)
    const files = await collectJsonFiles(directory)

    if (files.length === 0) {
      throw new RunnerConfigError(
        `no fixtures found for language "${lang}" at evals/fixtures/${selection.dataset}/${selection.version}/${lang}`,
      )
    }

    for (const file of files) {
      const relativePath = relative(root, file).split(sep).join('/')
      const fixture = await readFixture(file, relativePath)

      if (fixture.lang !== lang) {
        throw new RunnerConfigError(
          `fixture ${relativePath} declares lang "${fixture.lang}" but lives under "${lang}"`,
        )
      }

      if (selection.splits !== undefined && !selection.splits.includes(fixture.split)) continue
      if (selection.ids !== undefined && !selection.ids.includes(fixture.id)) continue

      selected.push({ fixture, relativePath })
    }
  }

  const seen = new Set<string>()
  for (const { fixture } of selected) {
    const key = `${fixture.lang}\u0000${fixture.id}`
    if (seen.has(key)) {
      throw new RunnerConfigError(
        `fixture id "${fixture.id}" appears more than once in language "${fixture.lang}"`,
      )
    }
    seen.add(key)
  }

  for (const lang of selection.languages) {
    if (!selected.some(({ fixture }) => fixture.lang === lang)) {
      throw new RunnerConfigError(
        `manifest selects no fixture for language "${lang}" after split/id filters`,
      )
    }
  }

  const languageOrder = new Map<Lang, number>(
    selection.languages.map((lang, index) => [lang, index]),
  )

  return selected.sort((left, right) => {
    const leftOrder = languageOrder.get(left.fixture.lang) ?? 0
    const rightOrder = languageOrder.get(right.fixture.lang) ?? 0
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    return compareStrings(left.fixture.id, right.fixture.id)
  })
}

/** Execute every registered repetition and build the result artifact. */
export async function executeRun(options: ExecuteRunOptions): Promise<RunExecution> {
  const manifest = parseManifest(options.manifest)
  const scorer = options.scorer ?? createDeterministicInvariantScorer()
  assertScorerMatchesManifest(scorer, manifest)

  const wallClock = options.wallClock ?? (() => new SystemClock().now())
  const startedAt = new Date(wallClock()).toISOString()

  const fixtures = await loadSelectedFixtures(options.repoRoot, manifest.fixtures)
  const provider = createProvider(manifest, fixtures)

  const rng = createSeededRandom(manifest.seeds.master)
  const orderedFixtures = shuffled(fixtures, rng)

  const repetitions: TracedRepetition[] = []
  const traces: RunTraceFile[] = []
  let failedPasses = 0

  for (let repetition = 0; repetition < manifest.limits.repetitions; repetition += 1) {
    let passFailed = false

    for (const { fixture } of orderedFixtures) {
      const clock = new FakeClock(0)

      try {
        const replayed = await replayFixture({
          runId: manifest.run.runId,
          fixture,
          clock,
          provider,
          wallNow: wallClock,
        })

        const events: SessionEvent[] = []
        for (const record of replayed.records) {
          const event = eventFromTraceRecord(record)
          if (event === undefined) {
            throw new RunnerConfigError(
              `trace record kind "${record.kind}" is not a §2.1 event; the replay harness cannot emit it`,
            )
          }
          events.push(event)
        }

        const guard = guardTurnEvents(events)
        const sequence = checkTraceSequence(replayed.records)
        const contentClassValid = replayed.records.every((record) => {
          if (!isSessionEventName(record.kind)) return false
          return record.contentClass === expectedContentClass(record.kind)
        })

        const relativePath = traceRelativePath(repetition, fixture.lang, fixture.id)
        const sha256 = sha256Hex(replayed.jsonl)

        repetitions.push({
          repetition,
          fixtureId: fixture.id,
          lang: fixture.lang,
          ok: true,
          records: replayed.records,
          jsonl: replayed.jsonl,
          traceSha256: sha256,
          tracePath: relativePath,
          violations: guard.violations,
          schemaValid: true,
          sequenceValid: sequence.ok,
          contentClassValid,
          providerOutage: false,
        })

        traces.push({
          fixtureId: fixture.id,
          lang: fixture.lang,
          repetition,
          relativePath,
          jsonl: replayed.jsonl,
          sha256,
        })
      } catch (error) {
        if (error instanceof CannedProviderMissError) {
          throw new RunnerConfigError(
            `canned replay is missing a recorded response (${error.message}); refusing to fall back`,
          )
        }

        if (error instanceof ReplayError) {
          throw new RunnerConfigError(`replay harness failure: ${error.message}`)
        }

        repetitions.push(failedRepetition(repetition, fixture, error))
        passFailed = true
      }
    }

    if (passFailed) failedPasses += 1
  }

  const metrics = await score(manifest, scorer, repetitions)
  const invariants = computeInvariants(manifest, repetitions)
  const summary = summarize(manifest, repetitions, failedPasses)
  const providerOutages = repetitions.filter((repetition) => repetition.providerOutage).length

  const verdict: RunVerdict = computeVerdict({
    manifest,
    metrics,
    repetitions: {
      requested: manifest.limits.repetitions,
      attempts: summary.attempts,
      completed: summary.completed,
    },
    invariants,
    providerOutages,
  })

  const result: RunResult = {
    schemaVersion: RUN_RESULT_SCHEMA_VERSION,
    runId: manifest.run.runId,
    suite: manifest.run.suite,
    manifestHash: manifestHash(manifest),
    manifest,
    verdict,
    metrics,
    invariants,
    repetitions: repetitions.map(toOutcome),
    traces: traces.map((trace) => ({
      fixtureId: trace.fixtureId,
      lang: trace.lang,
      repetition: trace.repetition,
      path: trace.relativePath,
      sha256: trace.sha256,
    })),
    summary,
    versions: buildVersions({ manifest, codeSha: options.codeSha }),
    startedAt,
    finishedAt: new Date(wallClock()).toISOString(),
  }

  // Parse the artifact we are about to persist: a result that does not satisfy
  // its own schema must never reach disk.
  return { result: parseRunResult(result), traces }
}

function assertScorerMatchesManifest(scorer: RunScorer, manifest: RunManifest): void {
  if (scorer.id !== manifest.scorer.id || scorer.version !== manifest.scorer.version) {
    throw new RunnerConfigError(
      `scorer mismatch: manifest registers "${manifest.scorer.id}" version "${manifest.scorer.version}" but the injected scorer is "${scorer.id}" version "${scorer.version}"`,
    )
  }
}

function createProvider(
  manifest: RunManifest,
  fixtures: readonly LoadedFixture[],
): CompletionProvider {
  if (manifest.provider.mode === 'live') {
    return createLiveProvider(manifest.provider.label)
  }

  const entries = fixtures.flatMap(({ fixture }) => buildCannedEntriesForFixture(fixture))
  return createCannedProvider(entries, manifest.provider.label)
}

async function score(
  manifest: RunManifest,
  scorer: RunScorer,
  repetitions: readonly TracedRepetition[],
): Promise<MetricReadings> {
  let raw: Readonly<Record<string, number>>
  try {
    raw = await scorer.score({ manifest, repetitions })
  } catch (error) {
    throw new RunnerConfigError(
      `scorer "${scorer.id}" failed: ${errorMessage(error)}; a failed model call is never a score`,
    )
  }

  const parsed = metricReadingsSchema.safeParse(raw)
  if (!parsed.success) {
    throw new RunnerConfigError(
      `scorer "${scorer.id}" returned invalid metric readings: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    )
  }

  const registered = [manifest.target.metric, ...manifest.guardrails.map((guard) => guard.metric)]
  const missing = registered.filter((metric) => parsed.data[metric] === undefined)
  if (missing.length > 0) {
    throw new RunnerConfigError(
      `scorer "${scorer.id}" did not measure registered axis(es): ${missing.join(', ')}`,
    )
  }

  return parsed.data
}

function computeInvariants(
  manifest: RunManifest,
  repetitions: readonly TracedRepetition[],
): InvariantResult[] {
  const completed = repetitions.filter((repetition) => repetition.ok)
  const registered = new Set(manifest.invariants)
  const results: InvariantResult[] = []

  const add = (id: InvariantResult['id'], ok: boolean, detail: string): void => {
    if (registered.has(id)) results.push({ id, ok, detail })
  }

  const nothingCompleted = completed.length === 0
  const noDataDetail = 'no completed repetition to evaluate'

  add(
    'trace.schema_valid',
    !nothingCompleted && completed.every((repetition) => repetition.schemaValid),
    nothingCompleted
      ? noDataDetail
      : `all ${completed.length} completed traces parse against the trace schema`,
  )

  const violations: readonly Violation[] = completed.flatMap((repetition) => repetition.violations)

  add(
    'trace.guard_clean',
    !nothingCompleted && violations.length === 0,
    nothingCompleted
      ? noDataDetail
      : `${violations.length} §3.2 guard violation(s) across completed traces`,
  )

  add(
    'trace.seq_monotonic',
    !nothingCompleted && completed.every((repetition) => repetition.sequenceValid),
    nothingCompleted ? noDataDetail : 'every completed trace has strictly increasing seq',
  )

  add(
    'trace.content_class',
    !nothingCompleted && completed.every((repetition) => repetition.contentClassValid),
    nothingCompleted
      ? noDataDetail
      : 'every text-bearing record is restricted and operational records are contentFree',
  )

  return results
}

function summarize(
  manifest: RunManifest,
  repetitions: readonly TracedRepetition[],
  failedPasses: number,
): RunSummary {
  const attempts = manifest.limits.repetitions
  const failed = failedPasses
  const completed = attempts - failed

  return {
    requestedRepetitions: manifest.limits.repetitions,
    attempts,
    completed,
    failed,
    failureRate: attempts === 0 ? 1 : failed / attempts,
    executions: repetitions.length,
    failedExecutions: repetitions.filter((repetition) => !repetition.ok).length,
  }
}

function failedRepetition(
  repetition: number,
  fixture: FixtureEntry,
  error: unknown,
): TracedRepetition {
  return {
    repetition,
    fixtureId: fixture.id,
    lang: fixture.lang,
    ok: false,
    records: [],
    violations: [],
    schemaValid: false,
    sequenceValid: false,
    contentClassValid: false,
    error: errorMessage(error),
    providerOutage: error instanceof ProviderUnavailableError,
  }
}

function toOutcome(repetition: TracedRepetition): RepetitionOutcome {
  const last = repetition.records.at(-1)

  return {
    repetition: repetition.repetition,
    fixtureId: repetition.fixtureId,
    lang: repetition.lang,
    ok: repetition.ok,
    records: repetition.records.length,
    ...(repetition.traceSha256 === undefined ? {} : { traceSha256: repetition.traceSha256 }),
    ...(repetition.tracePath === undefined ? {} : { tracePath: repetition.tracePath }),
    ...(last === undefined ? {} : { simDurationMs: last.tSim }),
    ...(repetition.error === undefined ? {} : { error: repetition.error }),
    providerOutage: repetition.providerOutage,
  }
}

async function readFixture(path: string, relativePath: string): Promise<FixtureEntry> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    throw new RunnerConfigError(`cannot read fixture ${relativePath}: ${errorMessage(error)}`)
  }

  const parsed = fixtureEntrySchema.safeParse(raw)
  if (!parsed.success) {
    throw new RunnerConfigError(
      `fixture ${relativePath} is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    )
  }

  return parsed.data
}

async function collectJsonFiles(directory: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw new RunnerConfigError(
      `cannot read fixture directory ${directory}: ${errorMessage(error)}`,
    )
  }

  const files: string[] = []
  for (const entry of [...entries].sort((left, right) => compareStrings(left.name, right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectJsonFiles(path)))
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(path)
    }
  }

  return files.sort(compareStrings)
}

function shuffled<T>(items: readonly T[], rng: SeededRandom): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = rng.int(index + 1)
    const current = copy[index]
    const swap = copy[swapIndex]
    if (current === undefined || swap === undefined) continue
    copy[index] = swap
    copy[swapIndex] = current
  }
  return copy
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
