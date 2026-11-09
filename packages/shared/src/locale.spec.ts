import { describe, expect, it, vi } from 'vitest'
import {
  LocaleTagError,
  baseLanguageOfLocale,
  canonicalizeLocale,
  isBaseLanguage,
  localeMatchesLanguage,
  sameLocale,
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
    expect(isBaseLanguage('en')).toBe(true)
    expect(isBaseLanguage('fr')).toBe(true)
    expect(isBaseLanguage('de')).toBe(false)
  })

  it('exposes the rejected tag and a typed error name', () => {
    try {
      canonicalizeLocale('de-DE')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(LocaleTagError)
      expect((error as LocaleTagError).name).toBe('LocaleTagError')
      expect((error as LocaleTagError).tag).toBe('de-DE')
      expect((error as Error).message).toBe(
        'locale "de-DE" has base language "de", but the product supports only en and fr',
      )
    }
  })

  it('rejects an empty or whitespace-only tag with the exact message', () => {
    for (const tag of ['', '   ']) {
      try {
        canonicalizeLocale(tag)
        expect.unreachable()
      } catch (error) {
        expect((error as Error).message).toBe('a locale tag must not be empty')
        expect((error as LocaleTagError).tag).toBe(tag)
      }
    }
  })

  it('keeps the Intl parse failure in the error message', () => {
    for (const tag of ['not a locale', 'en--GB', '@']) {
      expect(() => canonicalizeLocale(tag)).toThrow(LocaleTagError)
      expect(() => canonicalizeLocale(tag)).toThrow(/not a valid BCP 47 locale tag/)
      expect(() => canonicalizeLocale(tag)).not.toThrow(
        new RegExp(`^"${tag}" is not a valid BCP 47 locale tag$`),
      )
    }
    expect(tryCanonicalizeLocale('@')).toBeUndefined()
  })

  it('returns the canonical tag from the non-throwing form', () => {
    expect(tryCanonicalizeLocale('EN-gb')).toBe('en-GB')
    expect(tryCanonicalizeLocale('fr-CA')).toBe('fr-CA')
  })

  it('handles an Intl implementation that returns no canonical tag', () => {
    const spy = vi.spyOn(Intl, 'getCanonicalLocales').mockReturnValue([])
    try {
      expect(() => canonicalizeLocale('en')).toThrow('"en" is not a valid BCP 47 locale tag')
    } finally {
      spy.mockRestore()
    }
  })

  it('compares canonical tags, not their spelling', () => {
    expect(sameLocale('EN-gb', 'en-GB')).toBe(true)
    expect(sameLocale(' en ', 'en')).toBe(true)
    expect(sameLocale('en', 'fr')).toBe(false)
    expect(() => sameLocale('en', 'de-DE')).toThrow(LocaleTagError)
  })
})
