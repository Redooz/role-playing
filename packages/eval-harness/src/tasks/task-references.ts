/**
 * Per-task reference rules (M0 D5, gate G3).
 *
 * Reads one raw task entry's required metadata and resolves the persona,
 * scenario and routing references it declares against the registered kits. It
 * never reads the filesystem: the walker hands it already-parsed entries.
 */
import { PERSONAS_BY_ID, personaVariant } from '@rp/persona-kit'
import { SCENARIOS_BY_ID, scenarioVariant, type ScenarioVariant } from '@rp/scenario-kit'
import type { TaskEntry } from './schema.js'
import type { TaskViolation } from './violations.js'

/** The M0 provenance and annotation contract, checked before the schema. */
export function checkRequiredMetadata(
  raw: unknown,
  path: string,
  violations: TaskViolation[],
): void {
  if (!isRecord(raw)) return

  if (raw['provenance'] === undefined) {
    violations.push({
      path,
      code: 'MISSING_PROVENANCE',
      message: 'provenance is required (M0 default: { "source": "synthetic" })',
    })
  }

  const consentScope = raw['consentScope']
  if (typeof consentScope !== 'string' || consentScope.length === 0) {
    violations.push({
      path,
      code: 'MISSING_CONSENT_SCOPE',
      message: 'consentScope must be a non-empty string',
    })
  }

  const annotationVersions = raw['annotationVersions']
  if (!isRecord(annotationVersions) || Object.keys(annotationVersions).length === 0) {
    violations.push({
      path,
      code: 'MISSING_ANNOTATION_VERSIONS',
      message: 'annotationVersions must be a non-empty record of name → version',
    })
  }
}

export function checkRoutingReferences(
  entry: TaskEntry,
  path: string,
  violations: TaskViolation[],
): void {
  const routing = entry.routing
  if (entry.mode !== 'routing' || routing === undefined) return

  for (const persona of routing.context.personas) {
    if (!PERSONAS_BY_ID.has(persona.id)) {
      violations.push({
        path,
        code: 'ROUTING_PERSONA_UNKNOWN',
        message: `routing persona "${persona.id}" does not resolve to a registered persona`,
      })
    }
  }
}

export function checkSessionReferences(
  entry: TaskEntry,
  path: string,
  violations: TaskViolation[],
): void {
  const session = entry.session
  if (entry.mode !== 'session' || session === undefined) return

  const locale = entry.locale ?? entry.lang
  const personaIds = session.personaIds ?? [session.personaId]
  for (const personaId of personaIds) {
    const persona = PERSONAS_BY_ID.get(personaId)
    if (persona === undefined) {
      violations.push({
        path,
        code: 'SESSION_REFERENCE_MISSING',
        message: `personaId "${personaId}" does not resolve to a registered persona`,
      })
      continue
    }
    if (persona.version !== session.personaVersion) {
      violations.push({
        path,
        code: 'SESSION_VERSION_MISMATCH',
        message: `persona "${persona.id}" is version "${persona.version}", not "${session.personaVersion}"`,
      })
    }
    try {
      personaVariant(persona, locale)
    } catch {
      violations.push({
        path,
        code: 'SESSION_LOCALE_MISSING',
        message: `persona "${persona.id}" has no variant for locale "${locale}"`,
      })
    }
  }

  const scenario = SCENARIOS_BY_ID.get(session.scenarioId)
  if (scenario === undefined) {
    violations.push({
      path,
      code: 'SESSION_REFERENCE_MISSING',
      message: `scenarioId "${session.scenarioId}" does not resolve to a registered scenario`,
    })
    return
  }

  if (scenario.version !== session.scenarioVersion) {
    violations.push({
      path,
      code: 'SESSION_VERSION_MISMATCH',
      message: `scenario "${scenario.id}" is version "${scenario.version}", not "${session.scenarioVersion}"`,
    })
  }

  let variant: ScenarioVariant
  try {
    variant = scenarioVariant(scenario, locale)
  } catch {
    violations.push({
      path,
      code: 'SESSION_LOCALE_MISSING',
      message: `scenario "${scenario.id}" has no variant for locale "${locale}"`,
    })
    return
  }

  for (const personaId of personaIds) {
    if (!variant.personaIds.includes(personaId)) {
      violations.push({
        path,
        code: 'SESSION_PERSONA_MISMATCH',
        message: `scenario "${scenario.id}" does not include persona "${personaId}"`,
      })
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
