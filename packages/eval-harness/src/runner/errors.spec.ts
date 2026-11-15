import { describe, expect, it } from 'vitest'
import type { ManifestIssue } from './manifest.js'
import { HarnessConfigError, errorMessage } from './errors.js'

describe('HarnessConfigError', () => {
  it('carries the message, the name and no issues by default', () => {
    const error = new HarnessConfigError('the run cannot start')

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('HarnessConfigError')
    expect(error.message).toBe('the run cannot start')
    expect(error.issues).toStrictEqual([])
  })

  it('keeps the manifest issues it was given, in order', () => {
    const issues: readonly ManifestIssue[] = [
      { path: 'limits', message: 'limits: missing required field' },
      { path: 'grader.id', message: 'grader.id: too small' },
    ]

    const error = new HarnessConfigError('invalid run manifest', issues)

    expect(error.issues).toStrictEqual(issues)
    expect(error.issues).toBe(issues)
    expect(error.message).toBe('invalid run manifest')
  })
})

describe('errorMessage', () => {
  it('returns the message of an Error without the class name', () => {
    expect(errorMessage(new Error('provider down'))).toBe('provider down')
    expect(errorMessage(new TypeError('bad seed'))).toBe('bad seed')
  })

  it('stringifies a thrown non-Error value', () => {
    expect(errorMessage('plain text failure')).toBe('plain text failure')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(undefined)).toBe('undefined')
    expect(errorMessage(null)).toBe('null')
    const thrown = { code: 'E_FAKE' }
    expect(errorMessage(thrown)).toBe('[object Object]')
  })
})
