import { describe, expect, it } from 'vitest'
import { GRANDFATHERED_COMPOSITIONS, isGrandfathered } from './composition-grandfather.js'

describe('composition grandfather list', () => {
  it('grandfathers exactly the four pairs that predate the rule', () => {
    expect(GRANDFATHERED_COMPOSITIONS).toEqual([
      'synthetic-routing/1.0.0',
      'synthetic-multi-persona-session/m3b-v1',
      'synthetic-workplace/v1',
      'synthetic-workplace-session/v1',
    ])
  })

  it('matches a pair by name, never by being old', () => {
    expect(isGrandfathered('synthetic-routing', '1.0.0')).toBe(true)
    expect(isGrandfathered('synthetic-routing', '1.1.0')).toBe(false)
    expect(isGrandfathered('synthetic-workplace', 'v2')).toBe(false)
  })
})
