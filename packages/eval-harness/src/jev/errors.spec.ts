import { describe, expect, it } from 'vitest'
import {
  JevConfigError,
  JevError,
  JevInvalidResponseError,
  JevUnavailableError,
  type JevUnavailableReason,
} from './errors.js'

describe('JevError', () => {
  it('carries a stable code, name and message', () => {
    const error = new JevError('jev_config', 'bad configuration')

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('JevError')
    expect(error.code).toBe('jev_config')
    expect(error.message).toBe('bad configuration')
    expect(error.cause).toBeUndefined()
  })

  it('keeps the code it was constructed with', () => {
    const codes = ['jev_config', 'jev_unavailable', 'jev_invalid_response'] as const

    for (const code of codes) {
      expect(new JevError(code, 'message').code).toBe(code)
    }
  })

  it('passes a cause through to the native Error cause', () => {
    const cause = new Error('socket closed')

    const error = new JevError('jev_unavailable', 'upstream failed', { cause })

    expect(error.cause).toBe(cause)
  })
})

describe('JevConfigError', () => {
  it('names itself, uses the config code and starts with no details', () => {
    const error = new JevConfigError('Invalid Jev judgment.')

    expect(error).toBeInstanceOf(JevError)
    expect(error.name).toBe('JevConfigError')
    expect(error.code).toBe('jev_config')
    expect(error.message).toBe('Invalid Jev judgment.')
    expect(error.details).toStrictEqual([])
    expect(error.cause).toBeUndefined()
  })

  it('keeps the supplied details and cause', () => {
    const cause = new Error('validated')

    const error = new JevConfigError('Invalid Jev judgment.', {
      details: ['question.criteria: A choice question needs at least two criteria.'],
      cause,
    })

    expect(error.details).toStrictEqual([
      'question.criteria: A choice question needs at least two criteria.',
    ])
    expect(error.cause).toBe(cause)
  })

  it('treats undefined details as an empty list', () => {
    const error = new JevConfigError('message', { details: undefined })

    expect(error.details).toStrictEqual([])
  })
})

describe('JevUnavailableError', () => {
  it.each<JevUnavailableReason>(['network', 'http', 'timeout'])(
    'keeps the %s reason and an undefined status by default',
    (reason) => {
      const error = new JevUnavailableError('API unavailable', { reason })

      expect(error).toBeInstanceOf(JevError)
      expect(error.name).toBe('JevUnavailableError')
      expect(error.code).toBe('jev_unavailable')
      expect(error.message).toBe('API unavailable')
      expect(error.reason).toBe(reason)
      expect(error.status).toBeUndefined()
      expect(error.cause).toBeUndefined()
    },
  )

  it('keeps an HTTP status and cause', () => {
    const cause = new Error('provider down')

    const error = new JevUnavailableError('API returned 500', {
      reason: 'http',
      status: 500,
      cause,
    })

    expect(error.reason).toBe('http')
    expect(error.status).toBe(500)
    expect(error.cause).toBe(cause)
  })

  it('keeps a zero status instead of treating it as absent', () => {
    const error = new JevUnavailableError('API returned 0', { reason: 'http', status: 0 })

    expect(error.status).toBe(0)
  })
})

describe('JevInvalidResponseError', () => {
  it('names itself, uses the response code and starts with no details', () => {
    const error = new JevInvalidResponseError('Jev response did not match the schema.')

    expect(error).toBeInstanceOf(JevError)
    expect(error.name).toBe('JevInvalidResponseError')
    expect(error.code).toBe('jev_invalid_response')
    expect(error.message).toBe('Jev response did not match the schema.')
    expect(error.details).toStrictEqual([])
    expect(error.cause).toBeUndefined()
  })

  it('keeps the supplied details and cause', () => {
    const cause = new Error('parsed')

    const error = new JevInvalidResponseError('Jev response did not match the schema.', {
      details: ['model: Too small: expected string to have >=1 characters'],
      cause,
    })

    expect(error.details).toStrictEqual([
      'model: Too small: expected string to have >=1 characters',
    ])
    expect(error.cause).toBe(cause)
  })

  it('treats undefined details as an empty list', () => {
    const error = new JevInvalidResponseError('message', { details: undefined })

    expect(error.details).toStrictEqual([])
  })
})
