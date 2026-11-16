import { defineScenario } from '../scenario.js'
import { scriptedUser } from './helpers.js'

/**
 * Two-persona handover after a client demo (M3c P5).
 *
 * The demo is over and the client has left. The manager owns the rollout and
 * client communication; the peer owns the follow-up notes and action list.
 * Every responsibility the speaker labels rely on is written as a scenario fact
 * or a persona-scoped objective, so ownership is data rather than inference.
 */
export const postDemoHandoverScenario = defineScenario({
  id: 'post-demo-handover',
  version: '1.0.0',
  domain: 'workplace',
  scenarioType: 'post-demo-handover',
  cefrBand: 'B2',
  variants: {
    en: {
      lang: 'en',
      locale: 'en',
      setting: 'The client demo has just ended and the team is packing up in the meeting room.',
      learnerRole: 'A developer on the delivery team.',
      personaIds: ['manager', 'peer'],
      facts: [
        'The client demo was on Thursday.',
        'Sam owns the follow-up notes from the demo.',
        'Katherine owns client communication after the demo.',
        'Katherine owns the rollout summary.',
        'Katherine owns the pre-demo checklist.',
        'Sam owns the action list.',
        'The rollout is scheduled for next Friday.',
      ],
      objectives: [
        {
          id: 'confirm-handover',
          description: 'Confirm what the client asked for and who owns each follow-up.',
          successCriteria: [
            'Names the follow-up the client asked for',
            'Names the owner of each follow-up',
          ],
        },
        {
          id: 'agree-rollout',
          description: 'Agree the rollout date with the manager.',
          personaIds: ['manager'],
          keywords: ['rollout', 'friday', 'deployment', 'date'],
          successCriteria: ['Confirms the rollout date', 'Confirms what ships'],
        },
        {
          id: 'assess-actions',
          description: 'Ask the peer which follow-up actions are still open.',
          personaIds: ['peer'],
          keywords: ['actions', 'follow-up', 'notes', 'open'],
          successCriteria: ['Asks about open actions', 'Asks who owns the notes'],
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
          'The client has left after the demo. You are deciding with the team who follows up on what.',
      },
      scriptedUser: scriptedUser('post-demo-en', 'en', 'en', [
        'Katherine, is the rollout still planned for next Friday?',
        'Sam, which follow-up actions are still open?',
        'Who owns the follow-up notes?',
        'Thanks, noted. I will update the action list.',
      ]),
      successCriteria: [
        'The learner confirms the rollout date with the manager.',
        'The learner asks the peer about the open follow-up actions.',
        'The learner confirms the owner of the notes and states a next step.',
      ],
    },
    'en-GB': {
      lang: 'en',
      locale: 'en-GB',
      setting: 'The client demo has just finished and the team is packing up in the meeting room.',
      learnerRole: 'A developer on the delivery team.',
      personaIds: ['manager', 'peer'],
      facts: [
        'The client demo was on Thursday.',
        'Sam owns the follow-up notes from the demo.',
        'Katherine owns client communication after the demo.',
        'Katherine owns the rollout summary.',
        'Katherine owns the pre-demo checklist.',
        'Sam owns the action list.',
        'The rollout is booked for next Friday.',
      ],
      objectives: [
        {
          id: 'confirm-handover',
          description: 'Confirm what the client asked for and who owns each follow-up.',
          successCriteria: [
            'Names the follow-up the client asked for',
            'Names the owner of each follow-up',
          ],
        },
        {
          id: 'agree-rollout',
          description: 'Agree the rollout date with the manager.',
          personaIds: ['manager'],
          keywords: ['rollout', 'friday', 'deployment', 'date'],
          successCriteria: ['Confirms the rollout date', 'Confirms what goes out'],
        },
        {
          id: 'assess-actions',
          description: 'Ask the peer which follow-up actions are still open.',
          personaIds: ['peer'],
          keywords: ['actions', 'follow-up', 'notes', 'open'],
          successCriteria: ['Asks about open actions', 'Asks who owns the notes'],
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
          'The client has left after the demo. You are sorting out with the team who follows up on what.',
      },
      scriptedUser: scriptedUser('post-demo-en-gb', 'en', 'en-GB', [
        'Katherine, is the rollout still booked for next Friday?',
        'Sam, which follow-up actions are still open?',
        'Who owns the follow-up notes?',
        'Thanks, noted. I will update the action list.',
      ]),
      successCriteria: [
        'The learner uses natural British workplace phrasing (for example booked, sorted, follow up).',
        'The learner confirms the rollout date with the manager.',
        'The learner asks the peer about the open follow-up actions and states a next step.',
      ],
    },
    fr: {
      lang: 'fr',
      locale: 'fr',
      setting:
        'La démonstration client vient de se terminer et l’équipe range la salle de réunion.',
      learnerRole: 'Un développeur de l’équipe de livraison.',
      personaIds: ['manager', 'peer'],
      facts: [
        'La démonstration client a eu lieu jeudi.',
        'Samir est responsable des notes de suivi de la démo.',
        'Catherine est responsable de la communication client après la démo.',
        'Catherine est responsable du résumé de déploiement.',
        'Catherine est responsable de la liste de contrôle avant la démo.',
        'Samir est responsable de la liste d’actions.',
        'Le déploiement est prévu vendredi prochain.',
      ],
      objectives: [
        {
          id: 'confirm-handover',
          description: 'Confirmer ce que le client a demandé et qui suit chaque point.',
          successCriteria: [
            'Nomme le suivi demandé par le client',
            'Nomme le responsable de chaque suivi',
          ],
        },
        {
          id: 'agree-rollout',
          description: 'S’accorder avec la responsable sur la date de déploiement.',
          personaIds: ['manager'],
          keywords: ['déploiement', 'vendredi', 'date', 'livraison'],
          successCriteria: ['Confirme la date de déploiement', 'Confirme ce qui part'],
        },
        {
          id: 'assess-actions',
          description: 'Demander au collègue quelles actions de suivi sont encore ouvertes.',
          personaIds: ['peer'],
          keywords: ['actions', 'suivi', 'notes', 'ouvertes'],
          successCriteria: ['Interroge sur les actions ouvertes', 'Demande qui possède les notes'],
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
          'Le client vient de partir après la démo. Tu décides avec l’équipe qui suit chaque point.',
      },
      scriptedUser: scriptedUser('post-demo-fr', 'fr', 'fr', [
        'Catherine, le déploiement est-il toujours prévu vendredi prochain ?',
        'Samir, quelles actions de suivi sont encore ouvertes ?',
        'Qui est responsable des notes de suivi ?',
        'Merci, c’est noté. Je mets la liste d’actions à jour.',
      ]),
      successCriteria: [
        'L’apprenant confirme la date de déploiement avec la responsable.',
        'L’apprenant interroge le collègue sur les actions de suivi ouvertes.',
        'L’apprenant confirme le responsable des notes et énonce une prochaine étape.',
      ],
    },
    'fr-CA': {
      lang: 'fr',
      locale: 'fr-CA',
      setting:
        'La démo client vient de finir et l’équipe range la salle de réunion. Le registre est familier et québécois.',
      learnerRole: 'Un développeur de l’équipe de livraison.',
      personaIds: ['manager', 'peer'],
      facts: [
        'La démo client a eu lieu jeudi.',
        'Samir est responsable des notes de suivi de la démo.',
        'Catherine est responsable de la communication client après la démo.',
        'Catherine est responsable du résumé de déploiement.',
        'Catherine est responsable de la liste de vérification avant la démo.',
        'Samir est responsable de la liste d’actions.',
        'Le déploiement est prévu vendredi prochain.',
      ],
      objectives: [
        {
          id: 'confirm-handover',
          description: 'Confirmer ce que le client a demandé et qui suit chaque point.',
          successCriteria: [
            'Nomme le suivi demandé par le client',
            'Nomme la personne responsable de chaque suivi',
          ],
        },
        {
          id: 'agree-rollout',
          description: 'S’entendre avec la gestionnaire sur la date de déploiement.',
          personaIds: ['manager'],
          keywords: ['déploiement', 'vendredi', 'date', 'livraison'],
          successCriteria: ['Confirme la date de déploiement', 'Confirme ce qui part'],
        },
        {
          id: 'assess-actions',
          description: 'Demander au collègue quelles actions de suivi sont encore ouvertes.',
          personaIds: ['peer'],
          keywords: ['actions', 'suivi', 'notes', 'ouvertes'],
          successCriteria: [
            'Pose une question sur les actions ouvertes',
            'Demande qui a les notes',
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
          'Le client vient de partir après la démo. Tu décides avec l’équipe qui suit chaque point.',
      },
      scriptedUser: scriptedUser('post-demo-fr-ca', 'fr', 'fr-CA', [
        'Catherine, le déploiement est-tu toujours prévu vendredi prochain ?',
        'Samir, quelles actions de suivi sont encore ouvertes ?',
        'Qui est responsable des notes de suivi ?',
        'Merci, c’est noté. Je mets la liste d’actions à jour.',
      ]),
      successCriteria: [
        'L’apprenant utilise un registre québécois naturel (par exemple démo, correct, liste de vérification).',
        'L’apprenant confirme la date de déploiement avec la gestionnaire.',
        'L’apprenant interroge le collègue sur les actions ouvertes et nomme une prochaine étape.',
      ],
    },
  },
})
