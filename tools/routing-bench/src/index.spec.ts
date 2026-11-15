import { describe, expect, it } from 'vitest'
import { ROUTING_TIMING_ENV } from './index.js'

describe('routing-bench index', () => {
  it('exports the M3a timing opt-in variable name', () => {
    expect(ROUTING_TIMING_ENV).toBe('RUN_M3A_TIMING')
  })
})
