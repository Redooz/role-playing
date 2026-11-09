import { describe, expect, it } from 'vitest'
import {
  LocaleTagError,
  baseLanguageOfLocale,
  canonicalizeLocale,
  localeMatchesLanguage,
  tryCanonicalizeLocale,
} from './locale.js'

describe('BCP 47 locale tags', () => {
  it('canonicalizes the seeded locales', () => {
    expect(canonicalizeLocale('en')).toBe('en')
    expect(canonicalizeLocale('fr')).toBe('fr')
    expect(canonicalizeLocale('en-GB')).toBe('en-GB')
    expect(canonicalizeLocale('fr-CA')).toBe('fr-CA')
    expect(canonicalizeLocale(' EN-gb ')).toBe('en-GB')
  })

  it('rejects en-UK explicitly instead of mapping it silently', () => {
    expect(() => canonicalizeLocale('en-UK')).toThrow(LocaleTagError)
    expect(() => canonicalizeLocale('en-UK')).toThrow(/use en-GB/)
    expect(tryCanonicalizeLocale('en-UK')).toBeUndefined()
  })

  it('rejects malformed and unsupported tags', () => {
    expect(tryCanonicalizeLocale('')).toBeUndefined()
    expect(tryCanonicalizeLocale('not a locale')).toBeUndefined()
    expect(tryCanonicalizeLocale('de-DE')).toBeUndefined()
  })

  it('derives the base language and checks the match', () => {
    expect(baseLanguageOfLocale('en-GB')).toBe('en')
    expect(baseLanguageOfLocale('fr-CA')).toBe('fr')
    expect(localeMatchesLanguage('en-GB', 'en')).toBe(true)
    expect(localeMatchesLanguage('fr-CA', 'en')).toBe(false)
  })
})
