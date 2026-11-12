import { describe, expect, it } from 'vitest'
import { MAX_ITERATOR_CLOSE_MS, describeModelError, settleWithin } from './stream-utils.js'

describe('stream utilities', () => {
  it('returns a short, single-line cause for an Error', () => {
    expect(describeModelError(new Error('provider\n failed'))).toBe('Error: provider failed')
  })

  it('handles a non-Error cause without inventing a name', () => {
    expect(describeModelError('boom')).toBe('Error: boom')
    expect(describeModelError({ code: 7 })).toBe('Error: [object Object]')
  })

  it('bounds a long cause to 200 characters', () => {
    const detail = describeModelError(new Error('x'.repeat(400)))
    expect(detail).toHaveLength(200)
    expect(detail.endsWith('...')).toBe(true)
  })

  it('resolves when the promise settles first', async () => {
    await expect(settleWithin(Promise.resolve('done'), 50)).resolves.toBeUndefined()
  })

  it('resolves after the bound when the promise never settles', async () => {
    const started = Date.now()
    await settleWithin(new Promise(() => undefined), 5)
    expect(Date.now() - started).toBeGreaterThanOrEqual(4)
  })

  it('exposes the close bound', () => {
    expect(MAX_ITERATOR_CLOSE_MS).toBe(1_000)
  })
})
