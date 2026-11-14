/**
 * Cross-task index rules (M0 D5, gate G3).
 *
 * Duplicate ids and split leakage are properties of a whole dataset/version/
 * language scope, not of one file: the walker registers every entry here and
 * turns the accumulated index into violations after the tree is read.
 */
import type { Split } from './schema.js'
import type { TaskViolation } from './violations.js'

interface IdGroup {
  readonly id: string
  readonly scope: string
  readonly paths: string[]
}

export type IdIndex = Map<string, IdGroup>
export type SpeakerIndex = Map<string, Map<string, { path: string; split: Split }[]>>

export function registerId(
  ids: IdIndex,
  key: string,
  id: string,
  scope: string,
  path: string,
): void {
  const existing = ids.get(key)
  if (existing === undefined) {
    ids.set(key, { id, scope, paths: [path] })
  } else {
    existing.paths.push(path)
  }
}

export function registerSpeaker(
  speakers: SpeakerIndex,
  scope: string,
  speakerId: string,
  path: string,
  split: Split,
): void {
  let bySpeaker = speakers.get(scope)
  if (bySpeaker === undefined) {
    bySpeaker = new Map()
    speakers.set(scope, bySpeaker)
  }
  const records = bySpeaker.get(speakerId)
  if (records === undefined) {
    bySpeaker.set(speakerId, [{ path, split }])
  } else {
    records.push({ path, split })
  }
}

export function collectDuplicateIds(ids: IdIndex): TaskViolation[] {
  const violations: TaskViolation[] = []
  for (const [, group] of ids) {
    if (group.paths.length < 2) continue
    const [first, ...duplicates] = group.paths
    for (const path of duplicates) {
      violations.push({
        path,
        code: 'DUPLICATE_ID',
        message: `id "${group.id}" is already used by ${first} within ${group.scope}`,
      })
    }
  }
  return violations
}

export function collectSplitLeakage(speakers: SpeakerIndex): TaskViolation[] {
  const violations: TaskViolation[] = []
  for (const [scope, bySpeaker] of speakers) {
    for (const [speakerId, records] of bySpeaker) {
      const splits = new Set(records.map((record) => record.split))
      if (splits.size < 2) continue
      for (const record of records) {
        violations.push({
          path: record.path,
          code: 'SPLIT_LEAKAGE',
          message: `speakerId "${speakerId}" appears in both calibration and holdout within ${scope}`,
        })
      }
    }
  }
  return violations
}
