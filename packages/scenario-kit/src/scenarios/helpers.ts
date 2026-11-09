import type { BaseLanguage } from '@rp/shared'

/** Build the deterministic scripted user block for one locale variant. */
export function scriptedUser(
  id: string,
  lang: BaseLanguage,
  locale: string,
  turns: readonly string[],
): unknown {
  return {
    id,
    version: '1.0.0',
    lang,
    locale,
    mode: 'scripted',
    turns: turns.map((text) => ({ text })),
  }
}
