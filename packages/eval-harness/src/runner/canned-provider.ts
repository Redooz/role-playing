import { hashValue } from '@rp/shared'
import { z } from 'zod'

/**
 * Provider port used by the replay harness (M0 D3, Architecture Plan v5 §4.1.5).
 *
 * The evaluation harness only knows this interface. The M0 implementation is `canned`: it
 * replays recorded output keyed by the SHA-256 of the request's canonical JSON.
 * A request whose payload hash was not recorded is a **hard failure** with a
 * typed error — never a silent fallback, never an empty response, never a pass.
 *
 * A `live` implementation exists so the seam and its label are explicit. It does
 * not perform network calls at M0 and throws `ProviderUnavailableError`, which
 * the verdict treats as an infrastructure outage rather than a quality signal.
 */

export const completionMessageSchema = z.strictObject({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
})

export type CompletionMessage = z.infer<typeof completionMessageSchema>

/**
 * One atomic completion request. `metadata` participates in the canonical hash
 * (for example task id, language and turn index) so two similar but distinct
 * turns cannot collide.
 */
export const completionRequestSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  messages: z.array(completionMessageSchema),
  metadata: z.record(z.string(), z.string()).optional(),
})

export type CompletionRequest = z.infer<typeof completionRequestSchema>

export interface CompletionChunk {
  readonly text: string
  /** True on the last chunk of the response. */
  readonly done: boolean
}

export interface CompletionProvider {
  readonly kind: 'canned' | 'live'
  /** Label recorded with the run. Never contains secrets. */
  readonly label: string
  complete(request: CompletionRequest): AsyncIterable<CompletionChunk>
  /**
   * Release any per-trial resource (connection, worker, temp file). The
   * evaluation harness calls this once after every trial, whether the trial
   * passed or failed. Canned replay has nothing to release.
   */
  dispose?(): void | Promise<void>
}

export interface CannedEntry {
  readonly request: CompletionRequest
  /** Response chunks, replayed in order. */
  readonly chunks: readonly string[]
}

/** Canonical payload hash: identical requests always produce the same key. */
export function cannedRequestHash(request: CompletionRequest): string {
  return hashValue(request)
}

/** Thrown when a request has no recorded canned response. Never caught into a fallback. */
export class CannedProviderMissError extends Error {
  readonly payloadHash: string
  readonly provider: string
  readonly model: string

  constructor(request: CompletionRequest, payloadHash: string) {
    super(
      `no canned response for payload hash ${payloadHash} (provider "${request.provider}", model "${request.model}"); refusing to fall back`,
    )
    this.name = 'CannedProviderMissError'
    this.payloadHash = payloadHash
    this.provider = request.provider
    this.model = request.model
  }
}

/** Invalid canned bundle: duplicate keys, empty chunks, malformed requests. */
export class CannedProviderConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CannedProviderConfigError'
  }
}

/**
 * A provider surface could not answer (outage, timeout, not wired). The verdict
 * maps this to `infrastructure_inconclusive`, never to a failed judgment.
 */
export class ProviderUnavailableError extends Error {
  readonly providerLabel: string

  constructor(message: string, providerLabel: string) {
    super(message)
    this.name = 'ProviderUnavailableError'
    this.providerLabel = providerLabel
  }
}

/**
 * Build a canned provider from recorded entries.
 *
 * Every request is validated and every key must be unique. Duplicate payload
 * hashes are a configuration error instead of an arbitrary "last one wins",
 * because silent resolution order would make replay non-reproducible.
 */
export function createCannedProvider(
  entries: readonly CannedEntry[],
  label = 'canned-replay',
): CompletionProvider {
  const byHash = new Map<string, CannedEntry>()

  for (const [index, entry] of entries.entries()) {
    const parsed = completionRequestSchema.safeParse(entry.request)
    if (!parsed.success) {
      throw new CannedProviderConfigError(
        `canned entry ${index} has an invalid request: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      )
    }

    if (entry.chunks.length === 0) {
      throw new CannedProviderConfigError(`canned entry ${index} has no response chunks`)
    }

    const hash = cannedRequestHash(parsed.data)
    if (byHash.has(hash)) {
      throw new CannedProviderConfigError(
        `canned entry ${index} duplicates payload hash ${hash}; each request payload must be unique`,
      )
    }

    byHash.set(hash, { request: parsed.data, chunks: [...entry.chunks] })
  }

  return {
    kind: 'canned',
    label,
    complete(request) {
      const hash = cannedRequestHash(request)
      const entry = byHash.get(hash)
      if (entry === undefined) throw new CannedProviderMissError(request, hash)
      return replayChunks(entry.chunks)
    },
  }
}

/**
 * Explicitly labeled live surface. M0 makes no network calls: the manifest must
 * opt in (`provider.allowLive`), and even then this implementation reports an
 * outage so a live suite can never be mistaken for a canned result.
 */
export function createLiveProvider(label: string): CompletionProvider {
  return {
    kind: 'live',
    label,
    complete() {
      throw new ProviderUnavailableError(
        `live provider "${label}" is not wired at M0; no network call was made`,
        label,
      )
    },
  }
}

async function* replayChunks(chunks: readonly string[]): AsyncIterable<CompletionChunk> {
  for (const [index, text] of chunks.entries()) {
    yield { text, done: index === chunks.length - 1 }
  }
}
