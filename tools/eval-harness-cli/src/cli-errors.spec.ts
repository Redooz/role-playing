import { describe, expect, it } from 'vitest'
import { CliUsageError, errorMessage } from './cli-errors.js'

describe('CliUsageError', () => {
  it('is an Error carrying the caller-facing message and a stable name', () => {
    const error = new CliUsageError('unknown flag --nope')

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(CliUsageError)
    expect(error.message).toBe('unknown flag --nope')
    expect(error.name).toBe('CliUsageError')
  })

  it('keeps an empty message rather than inventing one', () => {
    expect(new CliUsageError('').message).toBe('')
  })
})

describe('errorMessage', () => {
  it('returns the message of a thrown Error subclass', () => {
    expect(errorMessage(new CliUsageError('bad flag'))).toBe('bad flag')
    expect(errorMessage(new RangeError('out of range'))).toBe('out of range')
  })

  it('stringifies a non-Error thrown value without losing it', () => {
    expect(errorMessage('plain string')).toBe('plain string')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(undefined)).toBe('undefined')
    expect(errorMessage(null)).toBe('null')
    expect(errorMessage({ message: 'not an Error' })).toBe('[object Object]')
  })
})
