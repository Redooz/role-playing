import { baseLanguageOfLocale, canonicalizeLocale, localeMatchesLanguage } from '@rp/shared'
import { z } from 'zod'

/**
 * Persona specification (M2 D1).
 *
 * Identity is shared across locales. A locale variant changes the displayed
 * name, voice, copy, spelling, vocabulary and regional conventions; it never
 * creates a second persona. Selecting a locale with no variant is a hard error.
 */

export const baseLanguageSchema = z.enum(['en', 'fr'])

export const localeSchema = z.string().transform((value, ctx) => {
  try {
    return canonicalizeLocale(value)
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : String(error),
    })
    return z.NEVER
  }
})

export const voiceSchema = z.strictObject({
  tone: z.string().min(1),
  formality: z.enum(['informal', 'neutral', 'formal']),
  warmth: z.enum(['low', 'medium', 'high']),
  directness: z.enum(['low', 'medium', 'high']),
  pace: z.enum(['measured', 'brisk']),
})

export type PersonaVoice = z.infer<typeof voiceSchema>

export const styleSchema = z.strictObject({
  sentenceLength: z.enum(['short', 'medium']),
  questionPolicy: z.enum(['at-most-one', 'none']),
  avoid: z.array(z.string().min(1)),
  plainText: z.literal(true),
})

export type PersonaStyle = z.infer<typeof styleSchema>

export const greetingSchema = z.strictObject({
  /** How the persona opens the conversation, in its own voice. */
  opensWith: z.string().min(1),
  /** A fact the persona must disclose in its first turn. */
  requiredDisclosure: z.string().min(1).optional(),
})

export type PersonaGreeting = z.infer<typeof greetingSchema>

export const personaExampleSchema = z.strictObject({
  user: z.string().min(1),
  persona: z.string().min(1),
})

export type PersonaExample = z.infer<typeof personaExampleSchema>

export const personaVariantSchema = z
  .strictObject({
    lang: baseLanguageSchema,
    locale: localeSchema,
    displayName: z.string().min(1),
    voice: voiceSchema,
    goals: z.array(z.string().min(1)).min(1),
    boundaries: z.array(z.string().min(1)).min(1),
    style: styleSchema,
    greeting: greetingSchema,
    examples: z.array(personaExampleSchema).max(2).optional(),
  })
  .superRefine((variant, ctx) => {
    if (!localeMatchesLanguage(variant.locale, variant.lang)) {
      ctx.addIssue({
        code: 'custom',
        path: ['locale'],
        message: `locale "${variant.locale}" does not match base language "${variant.lang}"`,
      })
    }
  })

export type PersonaVariant = z.infer<typeof personaVariantSchema>

export const personaSpecSchema = z
  .strictObject({
    id: z.string().min(1),
    version: z.string().min(1),
    role: z.string().min(1),
    organization: z.string().min(1),
    variants: z.record(z.string().min(1), personaVariantSchema),
  })
  .superRefine((persona, ctx) => {
    const keys = Object.keys(persona.variants)
    if (keys.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['variants'],
        message: 'at least one variant is required',
      })
    }

    for (const [key, variant] of Object.entries(persona.variants)) {
      if (canonicalizeLocale(key) !== variant.locale) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants', key, 'locale'],
          message: `variant key "${key}" does not match its locale "${variant.locale}"`,
        })
      }
      if (baseLanguageOfLocale(variant.locale) !== variant.lang) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants', key, 'lang'],
          message: `base language "${variant.lang}" does not match locale "${variant.locale}"`,
        })
      }
    }

    const languages = new Set(Object.values(persona.variants).map((variant) => variant.lang))
    for (const language of ['en', 'fr'] as const) {
      if (!languages.has(language)) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants'],
          message: `a persona must declare a "${language}" base variant`,
        })
      }
    }
  })

export type PersonaSpec = z.infer<typeof personaSpecSchema>

/** Parse and validate a persona at load. */
export function definePersona(input: unknown): PersonaSpec {
  return personaSpecSchema.parse(input)
}
