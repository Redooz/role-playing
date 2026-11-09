import { baseLanguageOfLocale, canonicalizeLocale, localeMatchesLanguage } from '@rp/shared'
import { z } from 'zod'

/**
 * Scenario and scripted-user specifications (M2 D2).
 *
 * A scenario has one shared identity and one variant per locale, mirroring
 * `PersonaSpec`. Content lives in data files; this module is only the schema
 * and lookup. Nothing here reads the environment, the clock or a provider.
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

export const objectiveSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().min(1),
  successCriteria: z.array(z.string().min(1)).min(1),
})

export type ScenarioObjective = z.infer<typeof objectiveSchema>

export const scriptedUserTurnSchema = z.strictObject({
  /** A learner utterance, written in the variant's language and locale. */
  text: z.string().min(1),
  /** Optional condition that ends the scripted run early. */
  stopCondition: z.string().min(1).optional(),
})

export type ScriptedUserTurn = z.infer<typeof scriptedUserTurnSchema>

export const scriptedUserModelSchema = z.strictObject({
  /** Pinned model id for an optional model-driven user probe. Never a grader. */
  id: z.string().min(1),
  seed: z.int().nonnegative(),
  transcriptPolicy: z.enum(['stored', 'restricted']),
})

export type ScriptedUserModel = z.infer<typeof scriptedUserModelSchema>

export const scriptedUserSchema = z
  .strictObject({
    id: z.string().min(1),
    version: z.string().min(1),
    lang: baseLanguageSchema,
    locale: localeSchema,
    mode: z.enum(['scripted', 'model']).default('scripted'),
    turns: z.array(scriptedUserTurnSchema).min(1),
    model: scriptedUserModelSchema.optional(),
  })
  .superRefine((user, ctx) => {
    if (!localeMatchesLanguage(user.locale, user.lang)) {
      ctx.addIssue({
        code: 'custom',
        path: ['locale'],
        message: `locale "${user.locale}" does not match base language "${user.lang}"`,
      })
    }
    if (user.mode === 'model' && user.model === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'a model-driven scripted user must pin its model, seed and transcript policy',
      })
    }
    if (user.mode === 'scripted' && user.model !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'only a model-driven scripted user may name a model',
      })
    }
  })

export type ScriptedUserSpec = z.infer<typeof scriptedUserSchema>

export const scenarioOpeningSchema = z.strictObject({
  /** The persona who opens the conversation. */
  personaId: z.string().min(1),
  situation: z.string().min(1),
  /** A disclosure the persona must make in its first turn. */
  requiredDisclosure: z.string().min(1).optional(),
})

export type ScenarioOpening = z.infer<typeof scenarioOpeningSchema>

export const scenarioVariantSchema = z
  .strictObject({
    lang: baseLanguageSchema,
    locale: localeSchema,
    setting: z.string().min(1),
    learnerRole: z.string().min(1),
    personaIds: z.array(z.string().min(1)).min(1),
    facts: z.array(z.string().min(1)).min(1),
    objectives: z.array(objectiveSchema).min(1),
    opening: scenarioOpeningSchema,
    scriptedUser: scriptedUserSchema,
    successCriteria: z.array(z.string().min(1)).min(1),
  })
  .superRefine((variant, ctx) => {
    if (!localeMatchesLanguage(variant.locale, variant.lang)) {
      ctx.addIssue({
        code: 'custom',
        path: ['locale'],
        message: `locale "${variant.locale}" does not match base language "${variant.lang}"`,
      })
    }
    if (!variant.personaIds.includes(variant.opening.personaId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['opening', 'personaId'],
        message: `opening persona "${variant.opening.personaId}" is not listed in personaIds`,
      })
    }
    if (variant.scriptedUser.lang !== variant.lang) {
      ctx.addIssue({
        code: 'custom',
        path: ['scriptedUser', 'lang'],
        message: 'the scripted user must run in the variant base language',
      })
    }
    if (variant.scriptedUser.locale !== variant.locale) {
      ctx.addIssue({
        code: 'custom',
        path: ['scriptedUser', 'locale'],
        message: 'the scripted user must run in the variant locale, not another locale',
      })
    }
  })

export type ScenarioVariant = z.infer<typeof scenarioVariantSchema>

export const scenarioSpecSchema = z
  .strictObject({
    id: z.string().min(1),
    version: z.string().min(1),
    domain: z.string().min(1),
    scenarioType: z.string().min(1),
    cefrBand: z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']),
    variants: z.record(z.string().min(1), scenarioVariantSchema),
  })
  .superRefine((scenario, ctx) => {
    const locales = Object.keys(scenario.variants)
    if (locales.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['variants'],
        message: 'at least one variant is required',
      })
    }

    for (const [key, variant] of Object.entries(scenario.variants)) {
      if (canonicalizeLocale(key) !== variant.locale) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants', key, 'locale'],
          message: `variant key "${key}" does not match its locale "${variant.locale}"`,
        })
      }
      const base = baseLanguageOfLocale(variant.locale)
      if (base !== variant.lang) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants', key, 'lang'],
          message: `base language "${variant.lang}" does not match locale "${variant.locale}"`,
        })
      }
    }

    const languages = new Set(Object.values(scenario.variants).map((variant) => variant.lang))
    for (const language of ['en', 'fr'] as const) {
      if (!languages.has(language)) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants'],
          message: `a scenario must declare a "${language}" base variant`,
        })
      }
    }
  })

export type ScenarioSpec = z.infer<typeof scenarioSpecSchema>

/** Parse and validate a scenario at load. Data files call this before export. */
export function defineScenario(input: unknown): ScenarioSpec {
  return scenarioSpecSchema.parse(input)
}
