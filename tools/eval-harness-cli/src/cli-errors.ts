/**
 * The eval-harness CLI's error vocabulary.
 *
 * A `CliUsageError` is a caller mistake (unknown flag, missing argument) and
 * maps to exit code 2. `errorMessage` renders an unknown thrown value without
 * losing its message.
 */

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
