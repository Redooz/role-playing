/**
 * BCP 47 locale tags (M2 D1).
 *
 * The product distinguishes the **base language** (`en` or `fr`) from the
 * **locale** (`en`, `fr`, `en-GB`, `fr-CA`). Base language drives task layout,
 * routing and Jev; locale drives persona copy, spelling, vocabulary and
 * regional conventions.
 *
 * `en-UK` is not the region tag the product means; the valid tag is `en-GB`.
 * Intl accepts `en-UK` syntactically, so it is rejected explicitly rather than
 * silently mapped: a wrong tag must fail, never fall back to another locale.
 */

/** Locales seeded by M2. The schema supports more; each new one needs its own copy and labels. */
export const SEEDED_LOCALES = ['en', 'fr', 'en-GB', 'fr-CA'] as const

export type SeededLocale = (typeof SEEDED_LOCALES)[number]

/** Base languages the product supports. */
export const BASE_LANGUAGES = ['en', 'fr'] as const

export type BaseLanguage = (typeof BASE_LANGUAGES)[number]

/** A canonical BCP 47 locale tag. */
export type LocaleTag = string

export class LocaleTagError extends Error {
  readonly tag: string

  constructor(tag: string, message: string) {
    super(message)
    this.name = 'LocaleTagError'
    this.tag = tag
  }
}

/** True when `tag` is one of the product's base languages. */
export function isBaseLanguage(value: string): value is BaseLanguage {
  return (BASE_LANGUAGES as readonly string[]).includes(value)
}

/**
 * Canonicalize a BCP 47 tag. Throws {@link LocaleTagError} on a tag that does
 * not parse, on `en-UK`, and on a tag whose language is not `en` or `fr`.
 */
export function canonicalizeLocale(tag: string): LocaleTag {
  const trimmed = tag.trim()
  if (trimmed === '') throw new LocaleTagError(tag, 'a locale tag must not be empty')
  if (trimmed.toLowerCase() === 'en-uk') {
    throw new LocaleTagError(tag, 'en-UK is not a valid region tag; use en-GB')
  }

  let canonical: string | undefined
  try {
    canonical = Intl.getCanonicalLocales(trimmed)[0]
  } catch (error) {
    throw new LocaleTagError(
      tag,
      `"${tag}" is not a valid BCP 47 locale tag: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (canonical === undefined) {
    throw new LocaleTagError(tag, `"${tag}" is not a valid BCP 47 locale tag`)
  }

  const language = baseLanguageOfLocale(canonical)
  if (!isBaseLanguage(language)) {
    throw new LocaleTagError(
      tag,
      `locale "${canonical}" has base language "${language}", but the product supports only en and fr`,
    )
  }

  return canonical
}

/** Non-throwing form of {@link canonicalizeLocale}. */
export function tryCanonicalizeLocale(tag: string): LocaleTag | undefined {
  try {
    return canonicalizeLocale(tag)
  } catch {
    return undefined
  }
}

/** Base language (`en` or `fr`) of a canonical locale tag. */
export function baseLanguageOfLocale(tag: string): string {
  return new Intl.Locale(tag).language
}

/** True when the locale's base language matches `language`. */
export function localeMatchesLanguage(locale: string, language: BaseLanguage): boolean {
  return baseLanguageOfLocale(locale) === language
}

/** Canonical tag equality. */
export function sameLocale(left: string, right: string): boolean {
  return canonicalizeLocale(left) === canonicalizeLocale(right)
}
