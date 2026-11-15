import { describe, expect, it } from 'vitest'
import {
  JEV_CACHE_SCHEMA_VERSION,
  JEV_DEFAULT_TIMEOUT_MS,
  JEV_ENDPOINT,
  JEV_GRADER_VERSION,
  JEV_MODEL,
  JEV_PROVIDER_SURFACE,
  JEV_SMOKE_RUBRIC_VERSION,
  JEV_SMOKE_SUITE_ID,
  NO_EXTRACTION_VERSION,
  isPinnedServedModel,
} from './constants.js'

describe('Jev constants', () => {
  it('pins the only callable model and its derived versions', () => {
    expect(JEV_MODEL).toBe('typesafe/jev-1.14')
    expect(JEV_GRADER_VERSION).toBe(JEV_MODEL)
  })

  it('names the OpenRouter Decisions surface', () => {
    expect(JEV_ENDPOINT).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(JEV_PROVIDER_SURFACE).toBe('openrouter/api/alpha/decisions')
  })

  it('stamps the smoke suite and extraction versions', () => {
    expect(JEV_SMOKE_RUBRIC_VERSION).toBe('jev-smoke-rubric-v1')
    expect(JEV_SMOKE_SUITE_ID).toBe('jev-smoke-v1')
    expect(NO_EXTRACTION_VERSION).toBe('none')
  })

  it('sets the default deadline and cache envelope version', () => {
    expect(JEV_DEFAULT_TIMEOUT_MS).toBe(20_000)
    expect(JEV_CACHE_SCHEMA_VERSION).toBe(1)
  })
})

describe('isPinnedServedModel', () => {
  it('accepts the exact pin', () => {
    expect(isPinnedServedModel(JEV_MODEL)).toBe(true)
  })

  it.each(['20261014', '20250101', '00000000'])(
    'accepts a dated snapshot of the same pin (%s)',
    (date) => {
      expect(isPinnedServedModel(`${JEV_MODEL}-${date}`)).toBe(true)
    },
  )

  it.each([
    'jev-latest',
    'typesafe/jev-latest',
    'typesafe/jev-1.13',
    'typesafe/jev-1.13-20260917',
    'typesafe/jev-1.15',
    'typesafe/jev-1.14-2026101',
    'typesafe/jev-1.14-202610141',
    'typesafe/jev-1.14-20261014-extra',
    'typesafe/jev-1.1',
    'typesafe/jev-1.140',
    'typesafe/jev-1.14 ',
    ' typesafe/jev-1.14',
    'openai/gpt-oss-20b',
    '',
  ])('rejects another model (%s)', (model) => {
    expect(isPinnedServedModel(model)).toBe(false)
  })

  it('does not treat the pin as a regular expression', () => {
    expect(isPinnedServedModel('typesafeXjev-1.14')).toBe(false)
    expect(isPinnedServedModel('typesafe/jev-1x14')).toBe(false)
  })
})
