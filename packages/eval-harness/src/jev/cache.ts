import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, sha256Hex } from '@rp/shared'
import { z } from 'zod'
import { JEV_CACHE_SCHEMA_VERSION } from './constants.js'
import { JevConfigError } from './errors.js'
import type { JevRequestPayload } from './types.js'

/**
 * Everything that can change the meaning of a cached score.
 *
 * The request payload includes the model, state, question id, instructions, and
 * rubric criteria. A changed transcript or prompt is therefore a new key and
 * can never reuse an older score (Architecture Plan v5 §4.3).
 */
export interface JevCacheKeyInput {
  readonly request: JevRequestPayload
  readonly graderVersion: string
  readonly rubricVersion: string
  readonly extractionVersion: string
  readonly providerSurface: string
}

/** SHA-256 of the canonical JSON form; stable across key insertion order. */
export function computeJevCacheKey(input: JevCacheKeyInput): string {
  return sha256Hex(
    canonicalJson({
      request: input.request,
      graderVersion: input.graderVersion,
      rubricVersion: input.rubricVersion,
      extractionVersion: input.extractionVersion,
      providerSurface: input.providerSurface,
    }),
  )
}

export interface JevCache {
  readonly directory: string
  /** Returns the cached raw response, or `undefined` on a miss or unreadable entry. */
  read(key: string): Promise<unknown | undefined>
  /** Atomically stores the full raw response. */
  write(key: string, raw: unknown): Promise<void>
}

interface JevCacheOptions {
  readonly directory: string
}

const cacheEntrySchema = z.object({
  cacheSchemaVersion: z.literal(JEV_CACHE_SCHEMA_VERSION),
  cacheKey: z.string().min(1),
  raw: z.unknown(),
})

const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/

/**
 * Default content-addressed cache location: `evals/.cache/` at the repo root.
 * It is git-ignored. It replays identical requests only; it is never a source
 * of baselines (those live in `evals/baselines/`).
 */
export function defaultJevCacheDir(): string {
  return fileURLToPath(new URL('../../../../evals/.cache', import.meta.url))
}

/**
 * File-backed Jev cache.
 *
 * Reads are best-effort: a missing, corrupt, or unreadable entry is a miss, and
 * the caller goes to the API. Writes are atomic (temp file + rename) so a
 * concurrent reader never observes a half-written entry.
 */
export function createFileJevCache(options: JevCacheOptions): JevCache {
  const directory = options.directory.trim()
  if (directory === '') {
    throw new JevConfigError('Jev cache directory must be non-empty.')
  }

  return {
    directory,

    async read(key) {
      try {
        const text = await readFile(cachePath(directory, key), 'utf8')
        const parsed = cacheEntrySchema.safeParse(JSON.parse(text))
        if (!parsed.success || parsed.data.cacheKey !== key) return undefined
        return parsed.data.raw
      } catch {
        return undefined
      }
    },

    async write(key, raw) {
      const file = cachePath(directory, key)
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
      const entry = {
        cacheSchemaVersion: JEV_CACHE_SCHEMA_VERSION,
        cacheKey: key,
        raw,
      }

      await mkdir(directory, { recursive: true })
      try {
        await writeFile(temp, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
        await rename(temp, file)
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
    },
  }
}

function cachePath(directory: string, key: string): string {
  if (!CACHE_KEY_PATTERN.test(key)) {
    throw new JevConfigError(`Invalid Jev cache key: ${JSON.stringify(key)}`)
  }
  return join(directory, `${key}.json`)
}
