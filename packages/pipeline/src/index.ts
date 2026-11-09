/**
 * `@rp/pipeline` — model adapters for the session driver (M1 D6).
 *
 * `session-core` owns the `TextModelPort`; this package implements it over a
 * provider HTTP API. The first adapter is Groq's OpenAI-compatible streaming
 * endpoint. Nothing here reads `.env`; the composition root passes the key.
 */

export * from './groq-text.adapter.js'
export * from './livekit-inference.adapter.js'
export * from './openai-compatible.js'
export * from './openrouter-text.adapter.js'
export * from './plain-text.adapter.js'
