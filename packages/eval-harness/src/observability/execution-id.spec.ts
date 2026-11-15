import { describe, expect, it } from 'vitest'
import { deriveExecutionId } from './execution-id.js'

describe('deriveExecutionId', () => {
  it('keeps the run id and start time readable', () => {
    const id = deriveExecutionId('m0-canned-replay', '2026-11-07T10:20:30.000Z')
    expect(id).toBe('m0-canned-replay-20261107T102030Z-cfe06eed')
  })

  it('is stable for the same run and start time', () => {
    const startedAt = '2026-11-07T10:20:30.000Z'
    expect(deriveExecutionId('suite', startedAt)).toBe(deriveExecutionId('suite', startedAt))
  })

  it('separates two executions of the same suite', () => {
    const first = deriveExecutionId('suite', '2026-11-07T10:20:30.000Z')
    const second = deriveExecutionId('suite', '2026-11-07T10:20:31.000Z')
    expect(first).not.toBe(second)
  })

  it('rejects an empty run id and a non-ISO timestamp', () => {
    expect(() => deriveExecutionId('', '2026-11-07T10:20:30.000Z')).toThrow(TypeError)
    expect(() => deriveExecutionId('suite', 'not-a-date')).toThrow(TypeError)
  })

  it('names the rejected field in the error message', () => {
    expect(() => deriveExecutionId('', '2026-11-07T10:20:30.000Z')).toThrow(
      new TypeError('runId must not be empty'),
    )
    expect(() => deriveExecutionId('suite', 'not-a-date')).toThrow(
      new TypeError('startedAt must be an ISO-8601 timestamp: not-a-date'),
    )
  })

  it('compacts a timestamp that has no milliseconds or has an offset', () => {
    expect(deriveExecutionId('suite', '2026-11-07T10:20:30Z')).toBe(
      'suite-20261107T102030Z-60e661d9',
    )
    expect(deriveExecutionId('suite', '2026-11-07T10:20:30.000+01:00')).toBe(
      'suite-20261107T102030.000+0100-25bf5d66',
    )
    expect(deriveExecutionId('m0-canned-replay', '2026-11-07T10:20:30.123Z')).toBe(
      'm0-canned-replay-20261107T102030Z-7af1f809',
    )
  })

  it('keeps the full run id and a URL-safe form', () => {
    const id = deriveExecutionId('suite/with spaces', '2026-11-07T10:20:30.000Z')
    expect(id.startsWith('suite/with spaces-')).toBe(true)
    expect(id).not.toMatch(/[.:]/u)
    expect(id).toMatch(/-\d{8}T\d{6}Z-[a-f0-9]{8}$/u)
  })
})
