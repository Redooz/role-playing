import type { SessionLanguage, TextModelUsage } from './events.js'

/**
 * Model port owned by `session-core` (M1 D1).
 *
 * The driver depends on this shape, never on a provider SDK. `packages/pipeline`
 * implements it for Groq; the eval harness adapts its existing
 * `CompletionProvider` to it. One port, not two.
 *
 * The stream lifecycle is part of the contract:
 * - `complete` must stop yielding once `signal` is aborted;
 * - the last chunk carries `done: true`;
 * - a provider error rejects the iterator instead of yielding fabricated text.
 *
 * Usage is optional because not every provider returns it, and a cancelled
 * request may not be billed at all. The adapter records what it receives.
 */

export const textModelRoleSchema = ['system', 'user', 'assistant'] as const

export type TextModelRole = (typeof textModelRoleSchema)[number]

export interface TextModelMessage {
  readonly role: TextModelRole
  readonly content: string
}

export interface TextModelChunk {
  readonly text: string
  /** True on the last chunk of the response. */
  readonly done: boolean
  /** Present on the last chunk when the provider reports usage. */
  readonly usage?: TextModelUsage
}

export interface TextModelRequest {
  readonly messages: readonly TextModelMessage[]
  /**
   * Stable labels that participate in a canned lookup. They never contain
   * secrets or user text.
   */
  readonly metadata?: Readonly<Record<string, string>>
  /**
   * Operational id for this model call (the turn id). It is deliberately not
   * part of `metadata`: it changes on every turn and must not change a canned
   * request hash. Adapters use it to tag timing, never to build the request body.
   */
  readonly requestId?: string
}

export interface TextModelCompleteOptions {
  readonly signal?: AbortSignal
}

export interface TextModelPort {
  /** `canned` replays recorded output; `live` calls a provider. */
  readonly kind: 'canned' | 'live'
  /** Label recorded with a transcript. Never contains a secret. */
  readonly label: string
  complete(
    request: TextModelRequest,
    options?: TextModelCompleteOptions,
  ): AsyncIterable<TextModelChunk>
  /** Release per-session resources (connection, worker, temp file). */
  dispose?(): void | Promise<void>
}

/** Language a driver session runs in. Re-exported here for model adapters. */
export type TextModelLanguage = SessionLanguage
