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
})
