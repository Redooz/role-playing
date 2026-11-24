/**
 * Keyword extraction shared by routing-context objectives and fact ownership.
 *
 * The stop-word list and the token rules are frozen: changing them changes the
 * deterministic policy's objective keywords, so this module must keep the M2/M3
 * behaviour byte-identical.
 */

const STOP_WORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'what',
  'when',
  'where',
  'which',
  'while',
  'into',
  'your',
  'you',
  'are',
  'was',
  'were',
  'have',
  'has',
  'had',
  'can',
  'could',
  'would',
  'should',
  'les',
  'des',
  'une',
  'aux',
  'avec',
  'pour',
  'dans',
  'sur',
  'est',
  'sont',
  'que',
  'qui',
  'quoi',
  'dont',
  'plus',
  'pas',
  'par',
  'vos',
  'votre',
  'son',
  'ses',
  'leur',
])

/** Lowercase and Unicode-normalise text for matching. */
export function normalizeKeywordText(text: string, lang: 'en' | 'fr'): string {
  return text.normalize('NFKC').toLocaleLowerCase(lang)
}

/** Split text into content tokens; the rule is frozen for compatibility. */
export function tokens(text: string, lang: 'en' | 'fr'): string[] {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase(lang)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
}

/** Keep non-empty values in first-seen order. */
export function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))]
}
