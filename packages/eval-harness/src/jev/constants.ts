/**
 * The only Jev model this package is allowed to call.
 *
 * Architecture Plan v5 §4.3 pins `typesafe/jev-1.14`; moving aliases such as
 * `jev-latest` are never accepted. The pin is enforced at client construction
 * and again on the served model in every response.
 */
export const JEV_MODEL = 'typesafe/jev-1.14' as const

/** Grader version stamped into cache keys. A different grader is a different model. */
export const JEV_GRADER_VERSION = JEV_MODEL

/** OpenRouter Decisions API surface. This is the alpha Decisions route, not chat completions. */
export const JEV_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'

/** Identifier for the provider surface, part of every cache key. */
export const JEV_PROVIDER_SURFACE = 'openrouter/api/alpha/decisions'

/** Rubric version for the pre-registered M0 smoke questions (gate G4). */
export const JEV_SMOKE_RUBRIC_VERSION = 'jev-smoke-rubric-v1'

/** Suite identifier for the 3-question canary. */
export const JEV_SMOKE_SUITE_ID = 'jev-smoke-v1'

/** Extraction version for judgments that consume text directly, without an extractor. */
export const NO_EXTRACTION_VERSION = 'none'

/** Default network deadline for one decision call. */
export const JEV_DEFAULT_TIMEOUT_MS = 20_000

/** Version of the on-disk cache entry envelope. Bumping it invalidates old entries. */
export const JEV_CACHE_SCHEMA_VERSION = 1

const SERVED_MODEL_PATTERN = new RegExp(
  `^${JEV_MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-\\d{8})?$`,
)

/**
 * The API resolves the pin to a dated snapshot such as
 * `typesafe/jev-1.14-20261014`. Both the exact pin and a dated snapshot of the
 * same version are accepted; another model is not.
 */
export function isPinnedServedModel(model: string): boolean {
  return SERVED_MODEL_PATTERN.test(model)
}
