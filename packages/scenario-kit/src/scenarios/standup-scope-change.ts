import { defineScenario } from '../scenario.js'
import { scriptedUser } from './helpers.js'

/**
 * Two-persona scope change during the daily stand-up.
 *
 * The manager removes one feature from the release; the peer owns part of that
 * work. Objectives are scoped per persona so routing relevance is defined for
 * both speakers instead of being duplicated across them.
 */
export const standupScopeChangeScenario = defineScenario({
  id: 'standup-scope-change',
  version: '1.0.0',
  domain: 'workplace',
  scenarioType: 'standup-scope-change',
  cefrBand: 'B2',
  variants: {
    en: {
      lang: 'en',
      locale: 'en',
      setting: 'The daily stand-up is nearly over when the manager announces a late scope change.',
      learnerRole: 'A developer on the release team.',
      personaIds: ['manager', 'peer'],
      facts: [
        'The release is scheduled for Friday.',
        'Notifications are moving to the next release.',
        'Sam has already built part of the notification work.',
        'The export feature is smaller and already tested.',
        'The client demo is on Wednesday.',
      ],
      objectives: [
        {
          id: 'confirm-scope',
          description: 'Confirm exactly what is moving out of this release.',
          successCriteria: [
            'Names the feature that moves',
            'Confirms the Friday release still happens',
          ],
        },
        {
          id: 'assess-impact',
          description: 'Ask the peer how much of the affected work is already done.',
          personaIds: ['peer'],
          keywords: ['impact', 'notifications', 'finished', 'risk'],
          successCriteria: ['Asks about completed work', 'Asks what is at risk'],
        },
        {
          id: 'agree-priority',
          description: 'Agree with the manager what ships first.',
          personaIds: ['manager'],
          keywords: ['priority', 'export', 'notifications', 'friday'],
          successCriteria: ['Confirms export ships on Friday', 'Confirms notifications wait'],
        },
        {
          id: 'state-next-step',
          description: 'State the next step and who owns it.',
          successCriteria: ['Names one next step', 'Names an owner'],
        },
      ],
      opening: {
        personaId: 'manager',
        situation:
          'You are closing the stand-up when you tell the team that notifications will not ship on Friday.',
      },
      scriptedUser: scriptedUser('standup-scope-en', 'en', 'en', [
        'Can you be specific about what is moving out of Friday’s release?',
        'Sam, how much of the notification work is already finished, and what would be at risk if we rushed it?',
        'So export still ships on Friday and notifications move to the next release. Katherine, is that the priority you want?',
        'Understood. I’ll update the board and ask Sam to document what is already done.',
      ]),
      successCriteria: [
        'The learner confirms that notifications move and the Friday release stays.',
        'The learner asks the peer about completed work and risk.',
        'The learner agrees the priority with the manager and states a next step with an owner.',
      ],
    },
    'en-GB': {
      lang: 'en',
      locale: 'en-GB',
      setting: 'The daily stand-up is nearly over when the manager announces a late scope change.',
      learnerRole: 'A developer on the release team.',
      personaIds: ['manager', 'peer'],
      facts: [
        'The release is booked for Friday.',
        'Notifications are moving to the next release.',
        'Sam has already built part of the notification work.',
        'The export feature is smaller and already tested.',
        'The client demo is on Wednesday.',
      ],
      objectives: [
        {
          id: 'confirm-scope',
          description: 'Confirm exactly what is moving out of this release.',
          successCriteria: [
            'Names the feature that moves',
            'Confirms the Friday release still goes ahead',
          ],
        },
        {
          id: 'assess-impact',
          description: 'Ask the peer how much of the affected work is already done.',
          personaIds: ['peer'],
          keywords: ['impact', 'notifications', 'sorted', 'risk'],
          successCriteria: ['Asks about completed work', 'Asks what is at risk'],
        },
        {
          id: 'agree-priority',
          description: 'Agree with the manager what ships first.',
          personaIds: ['manager'],
          keywords: ['priority', 'export', 'notifications', 'friday'],
          successCriteria: ['Confirms export ships on Friday', 'Confirms notifications wait'],
        },
        {
          id: 'state-next-step',
          description: 'State the next step and who owns it.',
          successCriteria: ['Names one next step', 'Names an owner'],
        },
      ],
      opening: {
        personaId: 'manager',
        situation:
          'You are wrapping up the stand-up when you tell the team that notifications will not go out on Friday.',
      },
      scriptedUser: scriptedUser('standup-scope-en-gb', 'en', 'en-GB', [
        'Could you be specific about what is moving out of Friday’s release?',
        'Sam, how much of the notification work is already sorted, and what would be at risk if we rushed it?',
        'So export still goes out on Friday and notifications move to the next release. Katherine, is that the priority you want?',
        'Right, I’ll update the board and ask Sam to jot down what is already done.',
      ]),
      successCriteria: [
        'The learner uses natural British workplace phrasing (for example sorted, go ahead, jot down).',
        'The learner confirms that notifications move and the Friday release stays.',
        'The learner agrees the priority with the manager and states a next step with an owner.',
      ],
    },
    fr: {
      lang: 'fr',
      locale: 'fr',
      setting:
        'Le point du matin se termine quand la responsable annonce un changement de périmètre tardif.',
      learnerRole: 'Un développeur de l’équipe de livraison.',
      personaIds: ['manager', 'peer'],
      facts: [
        'La livraison est prévue vendredi.',
        'Les notifications passent à la livraison suivante.',
        'Samir a déjà réalisé une partie du travail sur les notifications.',
        'La fonction d’export est plus petite et déjà testée.',
        'La démonstration client a lieu mercredi.',
      ],
      objectives: [
        {
          id: 'confirm-scope',
          description: 'Confirmer précisément ce qui sort de cette livraison.',
          successCriteria: [
            'Nomme la fonctionnalité concernée',
            'Confirme que la livraison de vendredi est maintenue',
          ],
        },
        {
          id: 'assess-impact',
          description: 'Demander au collègue quelle part du travail est déjà faite.',
          personaIds: ['peer'],
          keywords: ['impact', 'notifications', 'terminé', 'risque'],
          successCriteria: ['Interroge sur le travail terminé', 'Interroge sur les risques'],
        },
        {
          id: 'agree-priority',
          description: 'S’accorder avec la responsable sur ce qui part en premier.',
          personaIds: ['manager'],
          keywords: ['priorité', 'export', 'notifications', 'vendredi'],
          successCriteria: [
            'Confirme que l’export part vendredi',
            'Confirme que les notifications attendent',
          ],
        },
        {
          id: 'state-next-step',
          description: 'Énoncer la prochaine étape et son responsable.',
          successCriteria: ['Nomme une prochaine étape', 'Nomme un responsable'],
        },
      ],
      opening: {
        personaId: 'manager',
        situation:
          'Tu termines le point du matin quand tu annonces à l’équipe que les notifications ne partiront pas vendredi.',
      },
      scriptedUser: scriptedUser('standup-scope-fr', 'fr', 'fr', [
        'Peux-tu préciser ce qui sort de la livraison de vendredi ?',
        'Samir, quelle part du travail sur les notifications est déjà terminée, et qu’est-ce qui serait risqué si on accélérait ?',
        'Donc l’export part toujours vendredi et les notifications passent à la livraison suivante. Catherine, c’est bien la priorité que tu veux ?',
        'D’accord. Je mets à jour le tableau et je demande à Samir de documenter ce qui est déjà fait.',
      ]),
      successCriteria: [
        'L’apprenant confirme que les notifications sont reportées et que la livraison de vendredi est maintenue.',
        'L’apprenant interroge le collègue sur le travail terminé et les risques.',
        'L’apprenant s’accorde avec la responsable et énonce une prochaine étape avec un responsable.',
      ],
    },
    'fr-CA': {
      lang: 'fr',
      locale: 'fr-CA',
      setting:
        'La rencontre du matin achève quand la gestionnaire annonce un changement de portée de dernière minute. Le registre est familier et québécois.',
      learnerRole: 'Un développeur de l’équipe de livraison.',
      personaIds: ['manager', 'peer'],
      facts: [
        'La livraison est prévue vendredi.',
        'Les notifications passent à la livraison suivante.',
        'Samir a déjà fait une partie de la job sur les notifications.',
        'La fonction d’export est plus petite et déjà testée.',
        'La démo client est mercredi.',
      ],
      objectives: [
        {
          id: 'confirm-scope',
          description: 'Confirmer exactement ce qui sort de cette livraison.',
          successCriteria: [
            'Nomme la fonctionnalité concernée',
            'Confirme que la livraison de vendredi est maintenue',
          ],
        },
        {
          id: 'assess-impact',
          description: 'Demander au collègue quelle part de la job est déjà faite.',
          personaIds: ['peer'],
          keywords: ['impact', 'notifications', 'faite', 'risque'],
          successCriteria: [
            'Pose une question sur la job terminée',
            'Pose une question sur les risques',
          ],
        },
        {
          id: 'agree-priority',
          description: 'S’entendre avec la gestionnaire sur ce qui part en premier.',
          personaIds: ['manager'],
          keywords: ['priorité', 'export', 'notifications', 'vendredi'],
          successCriteria: [
            'Confirme que l’export part vendredi',
            'Confirme que les notifications attendent',
          ],
        },
        {
          id: 'state-next-step',
          description: 'Nommer la prochaine étape et la personne responsable.',
          successCriteria: ['Nomme une prochaine étape', 'Nomme une personne responsable'],
        },
      ],
      opening: {
        personaId: 'manager',
        situation:
          'Tu finis la rencontre du matin quand tu annonces à l’équipe que les notifications ne partiront pas vendredi.',
      },
      scriptedUser: scriptedUser('standup-scope-fr-ca', 'fr', 'fr-CA', [
        'Peux-tu préciser ce qui sort de la livraison de vendredi ?',
        'Samir, quelle part de la job sur les notifications est déjà faite, et qu’est-ce qui serait risqué si on se dépêchait ?',
        'Donc l’export part toujours vendredi et les notifications passent à la prochaine livraison. Catherine, c’est-tu la priorité que tu veux ?',
        'Correct. Je mets le tableau à jour et je demande à Samir de documenter ce qui est déjà fait.',
      ]),
      successCriteria: [
        'L’apprenant utilise un registre québécois naturel (par exemple job, démo, correct).',
        'L’apprenant confirme que les notifications sont reportées et que la livraison de vendredi est maintenue.',
        'L’apprenant s’entend avec la gestionnaire et nomme une prochaine étape avec une personne responsable.',
      ],
    },
  },
})
