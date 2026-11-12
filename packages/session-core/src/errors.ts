/**
 * Driver errors shared by the single- and multi-persona session paths.
 *
 * They live in their own module so the two drivers can throw the same types
 * without importing each other (which would make the factory a runtime cycle).
 */

export class SessionDriverError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionDriverError'
  }
}

export class SessionClosedError extends SessionDriverError {
  constructor() {
    super('the session is closed; send() is no longer accepted')
    this.name = 'SessionClosedError'
  }
}
