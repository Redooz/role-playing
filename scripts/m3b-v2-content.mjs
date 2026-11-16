/**
 * Content contract for `m3b-v2` (M3c P5).
 *
 * Two two-persona scenarios, four turns per task, and exact class counts per
 * language and split. The family patterns and the surface-form lists are
 * pre-registered: the generator cannot add, drop or rebalance a turn.
 */
import { handoverForms } from './m3b-v2-forms-handover.mjs'
import { standupForms } from './m3b-v2-forms-standup.mjs'

export const DATASET = 'synthetic-multi-persona-session'
export const VERSION = 'm3b-v2'
export const LANGS = ['en', 'fr']

/** Classes per split and language. Four turns per task sets the task counts. */
export const DISTRIBUTION = {
  calibration: { speak: 28, silence: 10, mixed: 2 },
  holdout: { speak: 34, silence: 12, mixed: 2 },
}

/** Family counts per split, summed over both scenarios. */
export const FAMILY_DISTRIBUTION = {
  calibration: {
    'TT-S1': 4,
    'TT-S2': 4,
    'TT-S3': 4,
    'TT-S4': 4,
    'TT-S5': 4,
    'TT-S6': 4,
    'TT-D1': 4,
    'TT-Q1': 3,
    'TT-Q2': 3,
    'TT-Q3': 2,
    'TT-Q4': 2,
    mixed: 2,
  },
  holdout: {
    'TT-S1': 5,
    'TT-S2': 4,
    'TT-S3': 4,
    'TT-S4': 4,
    'TT-S5': 4,
    'TT-S6': 5,
    'TT-D1': 8,
    'TT-Q1': 3,
    'TT-Q2': 3,
    'TT-Q3': 3,
    'TT-Q4': 3,
    mixed: 2,
  },
}

/**
 * Four-turn task patterns. The sum over both scenarios is
 * `FAMILY_DISTRIBUTION`, and the order is the task order on disk.
 */
export const PATTERNS = {
  calibration: {
    'standup-scope-change': [
      ['TT-S1', 'TT-S1', 'TT-S2', 'TT-S2'],
      ['TT-S3', 'TT-S3', 'TT-S4', 'TT-S4'],
      ['TT-S1', 'TT-S2', 'TT-D1', 'TT-Q1'],
      ['TT-S3', 'TT-S4', 'TT-D1', 'TT-Q1'],
      ['TT-S1', 'TT-S2', 'TT-S3', 'TT-S4'],
    ],
    'post-demo-handover': [
      ['TT-S5', 'TT-S5', 'TT-S6', 'TT-S6'],
      ['TT-S5', 'TT-S6', 'mixed', 'mixed'],
      ['TT-S5', 'TT-S6', 'TT-D1', 'TT-Q1'],
      ['TT-D1', 'TT-Q2', 'TT-Q2', 'TT-Q3'],
      ['TT-Q2', 'TT-Q3', 'TT-Q4', 'TT-Q4'],
    ],
  },
  holdout: {
    'standup-scope-change': [
      ['TT-S1', 'TT-S1', 'TT-S2', 'TT-S2'],
      ['TT-S1', 'TT-S2', 'TT-S3', 'TT-S4'],
      ['TT-S3', 'TT-S4', 'TT-D1', 'TT-D1'],
      ['TT-S1', 'TT-S3', 'TT-D1', 'TT-D1'],
      ['TT-S2', 'TT-S4', 'TT-D1', 'TT-Q1'],
      ['TT-S1', 'TT-S3', 'TT-S4', 'TT-Q1'],
    ],
    'post-demo-handover': [
      ['TT-S5', 'TT-S5', 'TT-S6', 'TT-S6'],
      ['TT-S5', 'TT-S6', 'TT-D1', 'TT-Q1'],
      ['TT-S5', 'TT-S6', 'TT-D1', 'TT-Q2'],
      ['TT-S6', 'TT-D1', 'TT-Q2', 'TT-Q3'],
      ['TT-Q2', 'TT-Q3', 'TT-Q4', 'TT-Q4'],
      ['TT-Q3', 'TT-Q4', 'mixed', 'mixed'],
    ],
  },
}

/** Locale order per scenario and split. The first three get the base locale. */
export const LOCALE_ORDER = ['en', 'en-GB', 'en', 'en-GB', 'en', 'en-GB']

export const SCENARIOS = {
  'standup-scope-change': {
    id: 'standup-scope-change',
    version: '1.0.0',
    slug: 'scope',
    brief: {
      en: 'The manager changes the release scope at stand-up; the learner clarifies impact and priority.',
      fr: 'La responsable modifie le périmètre de la livraison au point du matin ; l’apprenant clarifie l’impact et la priorité.',
    },
    facts: {
      en: [
        'The release is scheduled for Friday.',
        'Notifications are moving to the next release.',
        'Sam has already built part of the notification work.',
        'The export feature is smaller and already tested.',
        'The client demo is on Wednesday.',
      ],
      'en-GB': [
        'The release is booked for Friday.',
        'Notifications are moving to the next release.',
        'Sam has already built part of the notification work.',
        'The export feature is smaller and already tested.',
        'The client demo is on Wednesday.',
      ],
      fr: [
        'La livraison est prévue vendredi.',
        'Les notifications passent à la livraison suivante.',
        'Samir a déjà réalisé une partie du travail sur les notifications.',
        'La fonction d’export est plus petite et déjà testée.',
        'La démonstration client a lieu mercredi.',
      ],
      'fr-CA': [
        'La livraison est prévue vendredi.',
        'Les notifications passent à la livraison suivante.',
        'Samir a déjà fait une partie de la job sur les notifications.',
        'La fonction d’export est plus petite et déjà testée.',
        'La démo client est mercredi.',
      ],
    },
    objectivePersonaIds: {
      'assess-impact': ['peer'],
      'agree-priority': ['manager'],
    },
    forms: { en: standupForms.en, fr: standupForms.fr },
  },
  'post-demo-handover': {
    id: 'post-demo-handover',
    version: '1.0.0',
    slug: 'handover',
    brief: {
      en: 'After the client demo, the manager and peer divide the follow-up; the learner confirms owners and next steps.',
      fr: 'Après la démonstration client, la responsable et le collègue se répartissent le suivi ; l’apprenant confirme les responsables et les prochaines étapes.',
    },
    facts: {
      en: [
        'The client demo was on Thursday.',
        'Sam owns the follow-up notes from the demo.',
        'Katherine owns client communication after the demo.',
        'Katherine owns the rollout summary.',
        'Katherine owns the pre-demo checklist.',
        'Sam owns the action list.',
        'The rollout is scheduled for next Friday.',
      ],
      'en-GB': [
        'The client demo was on Thursday.',
        'Sam owns the follow-up notes from the demo.',
        'Katherine owns client communication after the demo.',
        'Katherine owns the rollout summary.',
        'Katherine owns the pre-demo checklist.',
        'Sam owns the action list.',
        'The rollout is booked for next Friday.',
      ],
      fr: [
        'La démonstration client a eu lieu jeudi.',
        'Samir est responsable des notes de suivi de la démo.',
        'Catherine est responsable de la communication client après la démo.',
        'Catherine est responsable du résumé de déploiement.',
        'Catherine est responsable de la liste de contrôle avant la démo.',
        'Samir est responsable de la liste d’actions.',
        'Le déploiement est prévu vendredi prochain.',
      ],
      'fr-CA': [
        'La démo client a eu lieu jeudi.',
        'Samir est responsable des notes de suivi de la démo.',
        'Catherine est responsable de la communication client après la démo.',
        'Catherine est responsable du résumé de déploiement.',
        'Catherine est responsable de la liste de vérification avant la démo.',
        'Samir est responsable de la liste d’actions.',
        'Le déploiement est prévu vendredi prochain.',
      ],
    },
    objectivePersonaIds: {
      'agree-rollout': ['manager'],
      'assess-actions': ['peer'],
    },
    forms: { en: handoverForms.en, fr: handoverForms.fr },
  },
}
