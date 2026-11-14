/**
 * Task/golden path layout (M0 D5, gate G3).
 *
 * The walker enforces this layout under `evals/`:
 *
 * ```text
 * evals/tasks/<dataset>/<version>/<lang>/.../*.json   (task entries)
 * evals/golden/<lang>/<version>/.../*.json            (golden entries)
 * ```
 *
 * These helpers only parse and describe that layout; they never touch the
 * filesystem, so a path can be validated before its file is read.
 */
import { LANGS, type Lang } from './schema.js'

export interface TaskLocation {
  dataset: string
  version: string
  lang: Lang
  scope: string
}

export interface GoldenLocation {
  version: string
  lang: Lang
  scope: string
}

export function parseTaskLocation(pathInEvals: string): TaskLocation | undefined {
  const [kind, dataset, version, lang, ...rest] = pathInEvals.split('/')
  if (kind !== 'tasks') return undefined
  if (dataset === undefined || dataset === '') return undefined
  if (version === undefined || version === '') return undefined
  if (lang === undefined || !isLang(lang)) return undefined
  if (rest.length === 0) return undefined
  return { dataset, version, lang, scope: `${dataset}/${version}/${lang}` }
}

export function parseGoldenLocation(pathInEvals: string): GoldenLocation | undefined {
  const [kind, lang, version, ...rest] = pathInEvals.split('/')
  if (kind !== 'golden') return undefined
  if (lang === undefined || !isLang(lang)) return undefined
  if (version === undefined || version === '') return undefined
  if (rest.length === 0) return undefined
  return { version, lang, scope: `${lang}/${version}` }
}

/** `evals/tasks/...` -> `tasks/...`; layout parsing is relative to `evals/`. */
export function relativeToEvals(displayPath: string): string {
  return displayPath.split('/').slice(1).join('/')
}

export function isLang(value: string): value is Lang {
  return (LANGS as readonly string[]).includes(value)
}
