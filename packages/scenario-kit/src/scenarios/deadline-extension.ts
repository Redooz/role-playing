import { defineScenario } from '../scenario.js'
import { scriptedUser } from './helpers.js'

/**
 * Manager asks a junior analyst about a quarterly report due on Friday.
 *
 * Shared identity across locales; the copy, spelling, register and workplace
 * norms change per variant. `en-GB` prefers British spelling and a slightly more
 * indirect register; `fr-CA` uses Québécois workplace vocabulary.
 */
export const deadlineExtensionScenario = defineScenario({
  id: 'request-deadline-extension',
  version: '1.0.0',
  domain: 'workplace',
  scenarioType: 'request-deadline-extension',
  cefrBand: 'B1',
  variants: {
    en: {
      lang: 'en',
      locale: 'en',
      setting: 'A one-to-one progress check on a quarterly report due on Friday.',
      learnerRole: 'A junior analyst who reports to the manager.',
      personaIds: ['manager'],
      facts: [
        'The quarterly report is due on Friday.',
        'The sales figures are still missing.',
        'The summary has not been written yet.',
        'The manager can approve a two-day extension if the headline numbers arrive on Friday.',
        'The board pack is reviewed on Monday.',
      ],
      objectives: [
        {
          id: 'ask-for-extension',
          description: 'Ask for a two-day extension clearly and politely.',
          successCriteria: ['States the request', 'Gives a reason', 'Names the new deadline'],
        },
        {
          id: 'offer-plan',
          description: 'Offer a concrete interim deliverable.',
          successCriteria: ['Names what will arrive on Friday', 'Names what will arrive on Monday'],
        },
        {
          id: 'confirm-agreement',
          description: 'Confirm the agreed plan before ending.',
          successCriteria: ['Repeats the deadline', 'Confirms the manager accepted it'],
        },
      ],
      opening: {
        personaId: 'manager',
        situation: 'You are checking in on the quarterly report before it is due.',
      },
      scriptedUser: scriptedUser('deadline-en', 'en', 'en', [
        "I'm still working on the quarterly report, and I'm worried about the Friday deadline. Could I have two more days?",
        'The sales figures are late, and I still need to write the summary. I could send the headline numbers on Friday and the full draft on Monday.',
        'Would Monday afternoon work for you? I want to make sure the board pack is not affected.',
        "Thanks. I'll send the headline numbers by Friday noon and the final draft on Monday.",
      ]),
      successCriteria: [
        'The learner names the Friday deadline and the two-day extension.',
        'The learner proposes an interim deliverable for Friday.',
        'The learner confirms the final deadline with the manager.',
      ],
    },
    'en-GB': {
      lang: 'en',
      locale: 'en-GB',
      setting:
        'A one-to-one progress check on a quarterly report that is due on Friday. The team uses British spelling and a relatively indirect register.',
      learnerRole: 'A junior analyst who reports to the manager.',
      personaIds: ['manager'],
      facts: [
        'The quarterly report is due on Friday.',
        'The sales figures have not arrived yet.',
        'The summary still needs to be written.',
        'The manager can approve a two-day extension if the headline figures arrive on Friday.',
        'The board pack is reviewed on Monday.',
      ],
      objectives: [
        {
          id: 'ask-for-extension',
          description: 'Ask for a two-day extension clearly but politely.',
          successCriteria: [
            'States the request without over-apologising',
            'Gives a reason',
            'Names the revised deadline',
          ],
        },
        {
          id: 'offer-plan',
          description: 'Offer a practical interim deliverable.',
          successCriteria: [
            'Names the headline figures for Friday',
            'Names the full draft for Monday',
          ],
        },
        {
          id: 'confirm-agreement',
          description: 'Confirm the agreed plan before finishing.',
          successCriteria: ['Repeats the revised deadline', 'Confirms the manager agreed'],
        },
      ],
      opening: {
        personaId: 'manager',
        situation: 'You are checking in on the quarterly report before it is due on Friday.',
      },
      scriptedUser: scriptedUser('deadline-en-gb', 'en', 'en-GB', [
        "I'm still working on the quarterly report and I'm a little concerned about Friday. Could I have two more days, please?",
        "The sales figures haven't come through yet and I still need to write the summary. I could get the headline figures over to you on Friday and send the full draft on Monday.",
        'Would Monday afternoon suit you? I want to make sure the board pack is not held up.',
        "Thank you. I'll get the headline figures to you by Friday midday and the final draft on Monday.",
      ]),
      successCriteria: [
        'The learner uses British spelling in any written words (for example prioritise, organise).',
        'The learner names the Friday deadline and the two-day extension.',
        'The learner proposes an interim deliverable and confirms the revised deadline.',
      ],
    },
    fr: {
      lang: 'fr',
      locale: 'fr',
      setting:
        'Un point individuel sur un rapport trimestriel attendu vendredi. Le registre est professionnel et le vouvoiement est attendu.',
      learnerRole: 'Une analyste junior qui travaille sous la responsabilité de la responsable.',
      personaIds: ['manager'],
      facts: [
        'Le rapport trimestriel est attendu vendredi.',
        'Les chiffres de l’équipe commerciale manquent encore.',
        'La synthèse reste à rédiger.',
        'La responsable peut accorder deux jours de plus si les chiffres principaux arrivent vendredi.',
        'Le dossier du conseil est examiné lundi.',
      ],
      objectives: [
        {
          id: 'ask-for-extension',
          description: 'Demander un délai de deux jours de façon claire et polie.',
          successCriteria: [
            'Formule la demande',
            'Donne une raison',
            'Annonce la nouvelle échéance',
          ],
        },
        {
          id: 'offer-plan',
          description: 'Proposer un livrable intermédiaire concret.',
          successCriteria: [
            'Précise ce qui sera envoyé vendredi',
            'Précise ce qui sera envoyé lundi',
          ],
        },
        {
          id: 'confirm-agreement',
          description: 'Confirmer l’accord avant de terminer.',
          successCriteria: ['Répète l’échéance', 'Confirme que la responsable a accepté'],
        },
      ],
      opening: {
        personaId: 'manager',
        situation: 'Vous faites le point sur le rapport trimestriel avant l’échéance.',
      },
      scriptedUser: scriptedUser('deadline-fr', 'fr', 'fr', [
        'Je travaille encore sur le rapport trimestriel et je m’inquiète un peu de la date de vendredi. Est-ce que je pourrais avoir deux jours de plus ?',
        'Les chiffres de l’équipe commerciale sont en retard et je dois encore rédiger la synthèse. Je pourrais vous envoyer les chiffres principaux vendredi et la version complète lundi.',
        'Est-ce que lundi après-midi vous conviendrait ? Je veux éviter de retarder le dossier du conseil.',
        'Merci. Je vous envoie les chiffres principaux vendredi midi et la version finale lundi.',
      ]),
      successCriteria: [
        'L’apprenant nomme l’échéance de vendredi et le délai de deux jours.',
        'L’apprenant propose un livrable intermédiaire pour vendredi.',
        'L’apprenant confirme l’échéance finale avec la responsable.',
      ],
    },
    'fr-CA': {
      lang: 'fr',
      locale: 'fr-CA',
      setting:
        'Un suivi individuel sur un rapport trimestriel attendu vendredi. Le vocabulaire professionnel québécois est attendu (courriel, échéancier).',
      learnerRole: 'Une analyste junior qui relève de la responsable.',
      personaIds: ['manager'],
      facts: [
        'Le rapport trimestriel est attendu vendredi.',
        'Les chiffres de l’équipe des ventes ne sont pas encore arrivés.',
        'La synthèse reste à rédiger.',
        'La responsable peut accorder deux jours de plus si les chiffres préliminaires arrivent vendredi.',
        'Le dossier du conseil est révisé lundi.',
      ],
      objectives: [
        {
          id: 'ask-for-extension',
          description: 'Demander un délai de deux jours de façon claire et polie.',
          successCriteria: [
            'Formule la demande',
            'Donne une raison',
            'Annonce la nouvelle échéance',
          ],
        },
        {
          id: 'offer-plan',
          description: 'Proposer un livrable intermédiaire concret.',
          successCriteria: [
            'Précise ce qui sera envoyé vendredi',
            'Précise ce qui sera envoyé lundi',
          ],
        },
        {
          id: 'confirm-agreement',
          description: 'Confirmer l’entente avant de terminer.',
          successCriteria: ['Répète l’échéance', 'Confirme que la responsable a accepté'],
        },
      ],
      opening: {
        personaId: 'manager',
        situation: 'Vous faites le suivi du rapport trimestriel avant l’échéance.',
      },
      scriptedUser: scriptedUser('deadline-fr-ca', 'fr', 'fr-CA', [
        'Je travaille encore sur le rapport trimestriel et je m’inquiète de l’échéancier de vendredi. Est-ce que je pourrais avoir deux jours de plus ?',
        'Les chiffres de l’équipe des ventes sont en retard et je dois encore rédiger la synthèse. Je pourrais vous envoyer les chiffres préliminaires vendredi et la version complète lundi.',
        'Est-ce que lundi après-midi vous conviendrait ? Je veux m’assurer de ne pas retarder le dossier du conseil.',
        'Merci. Je vous envoie les chiffres préliminaires vendredi midi et la version finale lundi.',
      ]),
      successCriteria: [
        'L’apprenant utilise un vocabulaire québécois naturel (par exemple courriel, échéancier).',
        'L’apprenant nomme l’échéance de vendredi et le délai de deux jours.',
        'L’apprenant propose un livrable intermédiaire et confirme l’échéance finale.',
      ],
    },
  },
})
