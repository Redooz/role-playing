/**
 * Versions that predate the composition rule (M3c P2).
 *
 * These four dataset/version pairs may omit `composition.json`. A pair is
 * grandfathered by name, never by being old, so a new version of the same
 * dataset still needs the file. The walker uses this list to report a missing
 * composition; the run-time guard uses it to decide whether a run may proceed
 * without one.
 */

export const GRANDFATHERED_COMPOSITIONS = [
  'synthetic-routing/1.0.0',
  'synthetic-multi-persona-session/m3b-v1',
  'synthetic-workplace/v1',
  'synthetic-workplace-session/v1',
] as const

export function isGrandfathered(dataset: string, version: string): boolean {
  return (GRANDFATHERED_COMPOSITIONS as readonly string[]).includes(`${dataset}/${version}`)
}
