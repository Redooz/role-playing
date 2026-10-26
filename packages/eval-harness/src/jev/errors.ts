/** Stable error codes callers can branch on without parsing messages. */
export type JevErrorCode = 'jev_config' | 'jev_unavailable' | 'jev_invalid_response'

/**
 * Base class for every Jev failure.
 *
 * Failures are surfaced through the `JevResult` union, never as a label,
 * probability, zero, or pass. Callers must mark the run incomplete.
 */
export class JevError extends Error {
  readonly code: JevErrorCode

  constructor(code: JevErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'JevError'
    this.code = code
  }
}

/** Invalid client configuration or an invalid judgment. Nothing was sent. */
export class JevConfigError extends JevError {
  readonly details: readonly string[]

  constructor(message: string, options: { details?: readonly string[]; cause?: unknown } = {}) {
    super('jev_config', message, { cause: options.cause })
    this.name = 'JevConfigError'
    this.details = options.details ?? []
  }
}

export type JevUnavailableReason = 'network' | 'http' | 'timeout'

/** The API could not produce an answer: transport failure, timeout, or non-2xx. */
export class JevUnavailableError extends JevError {
  readonly reason: JevUnavailableReason
  readonly status: number | undefined

  constructor(
    message: string,
    options: { reason: JevUnavailableReason; status?: number; cause?: unknown },
  ) {
    super('jev_unavailable', message, { cause: options.cause })
    this.name = 'JevUnavailableError'
    this.reason = options.reason
    this.status = options.status
  }
}

/** A response arrived but was not a valid, complete, pinned-model distribution. */
export class JevInvalidResponseError extends JevError {
  readonly details: readonly string[]

  constructor(message: string, options: { details?: readonly string[]; cause?: unknown } = {}) {
    super('jev_invalid_response', message, { cause: options.cause })
    this.name = 'JevInvalidResponseError'
    this.details = options.details ?? []
  }
}
