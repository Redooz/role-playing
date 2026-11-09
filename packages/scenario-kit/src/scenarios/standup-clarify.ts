import { defineScenario } from '../scenario.js'
import { scriptedUser } from './helpers.js'

/**
 * Peer colleague clarifies an ambiguous ticket after the daily stand-up.
 *
 * The register is informal in both languages. `fr-CA` uses Québécois workplace
 * vocabulary and a slightly more direct peer register.
 */
export const standupClarifyScenario = defineScenario({
  id: 'clarify-task-in-standup',
  version: '1.0.0',
  domain: 'workplace',
  scenarioType: 'clarify-task-in-standup',
  cefrBand: 'B2',
  variants: {
    en: {
      lang: 'en',
      locale: 'en',
      setting: 'The daily stand-up has just ended and a teammate is still at the board.',
      learnerRole: 'A teammate on the same delivery team.',
      personaIds: ['peer'],
      facts: [
        'Ticket PAY-214 is about retrying failed payments.',
        'The acceptance criteria are unclear.',
        'The API contract is already frozen.',
        'A demo is scheduled for Thursday.',
      ],
      objectives: [
        {
          id: 'state-confusion',
          description: 'Say which part of the task is unclear.',
          successCriteria: ['Names the ticket', 'Names the unclear criterion'],
        },
        {
          id: 'ask-question',
          description: 'Ask one concrete clarifying question.',
          successCriteria: ['Asks a question the teammate can answer', 'Stays on the task'],
        },
        {
          id: 'confirm-understanding',
          description: 'Repeat the agreed interpretation.',
          successCriteria: ['Summarises the expected behaviour', 'Confirms the demo constraint'],
        },
      ],
      opening: {
        personaId: 'peer',
        situation: 'You are packing up after stand-up when your teammate asks about the ticket.',
      },
      scriptedUser: scriptedUser('standup-en', 'en', 'en', [
        "I'm not sure I understood the acceptance criteria for PAY-214. Could you clarify what counts as done?",
        'So a payment that fails twice should be retried automatically, but only before the demo? What should happen after that?',
        'Should I also show the retry count in the UI, or is that out of scope for Thursday?',
        "Got it. I'll implement automatic retries before the demo and keep the count internal for now.",
      ]),
      successCriteria: [
        'The learner names the ticket and the unclear acceptance criterion.',
        'The learner asks at least one concrete question about expected behaviour.',
        'The learner confirms the interpretation and the Thursday demo constraint.',
      ],
    },
    'en-GB': {
      lang: 'en',
      locale: 'en-GB',
      setting: 'The daily stand-up has just finished and a teammate is still at the board.',
      learnerRole: 'A teammate on the same delivery team.',
      personaIds: ['peer'],
      facts: [
        'Ticket PAY-214 covers retrying failed payments.',
        'The acceptance criteria are not quite clear.',
        'The API contract is already frozen.',
        'A demo is booked for Thursday.',
      ],
      objectives: [
        {
          id: 'state-confusion',
          description: 'Say which part of the task is unclear.',
          successCriteria: ['Names the ticket', 'Names the unclear criterion'],
        },
        {
          id: 'ask-question',
          description: 'Ask one concrete clarifying question.',
          successCriteria: ['Asks a question the teammate can answer', 'Stays on the task'],
        },
        {
          id: 'confirm-understanding',
          description: 'Repeat the agreed interpretation.',
          successCriteria: ['Summarises the expected behaviour', 'Confirms the demo constraint'],
        },
      ],
      opening: {
        personaId: 'peer',
        situation: 'You are packing up after stand-up when your teammate asks about the ticket.',
      },
      scriptedUser: scriptedUser('standup-en-gb', 'en', 'en-GB', [
        "I didn't quite follow the acceptance criteria for PAY-214. Could you clarify what counts as done?",
        'So a payment that fails twice should be retried automatically, but only before the demo? What should happen afterwards?',
        'Should I also show the retry count in the UI, or is that out of scope for Thursday?',
        "Right, I'll sort out automatic retries before the demo and keep the count internal for now.",
      ]),
      successCriteria: [
        'The learner uses natural British workplace phrasing (for example sort out, booked, afterwards).',
        'The learner names the ticket and the unclear acceptance criterion.',
        'The learner confirms the interpretation and the Thursday demo constraint.',
      ],
    },
    fr: {
      lang: 'fr',
      locale: 'fr',
      setting:
        'Le point du matin vient de se terminer et un collègue est encore devant le tableau.',
      learnerRole: 'Un collègue de la même équipe de livraison.',
      personaIds: ['peer'],
      facts: [
        'Le ticket PAY-214 concerne la nouvelle tentative de paiement en cas d’échec.',
        'Les critères d’acceptation ne sont pas clairs.',
        'Le contrat d’API est déjà figé.',
        'Une démonstration est prévue jeudi.',
      ],
      objectives: [
        {
          id: 'state-confusion',
          description: 'Dire quelle partie de la tâche n’est pas claire.',
          successCriteria: ['Nomme le ticket', 'Nomme le critère flou'],
        },
        {
          id: 'ask-question',
          description: 'Poser une question de clarification concrète.',
          successCriteria: [
            'Pose une question à laquelle le collègue peut répondre',
            'Reste sur la tâche',
          ],
        },
        {
          id: 'confirm-understanding',
          description: 'Reformuler l’interprétation convenue.',
          successCriteria: [
            'Résume le comportement attendu',
            'Confirme la contrainte de la démonstration',
          ],
        },
      ],
      opening: {
        personaId: 'peer',
        situation:
          'Tu ranges tes affaires après le point du matin quand ton collègue t’interroge sur le ticket.',
      },
      scriptedUser: scriptedUser('standup-fr', 'fr', 'fr', [
        'Je ne suis pas sûr d’avoir compris les critères d’acceptation de PAY-214. Tu peux préciser ce qui compte comme terminé ?',
        'Donc un paiement qui échoue deux fois doit être retenté automatiquement, mais seulement avant la démonstration ? Et après ?',
        'Est-ce que je dois aussi afficher le nombre de tentatives dans l’interface, ou c’est hors périmètre pour jeudi ?',
        'D’accord. Je mets en place les nouvelles tentatives automatiques avant la démonstration et je garde le compteur en interne pour l’instant.',
      ]),
      successCriteria: [
        'L’apprenant nomme le ticket et le critère d’acceptation flou.',
        'L’apprenant pose au moins une question concrète sur le comportement attendu.',
        'L’apprenant confirme l’interprétation et la contrainte de la démonstration de jeudi.',
      ],
    },
    'fr-CA': {
      lang: 'fr',
      locale: 'fr-CA',
      setting:
        'La rencontre du matin vient de se terminer et un collègue est encore devant le tableau. Le registre est familier et québécois.',
      learnerRole: 'Un collègue de la même équipe de livraison.',
      personaIds: ['peer'],
      facts: [
        'Le billet PAY-214 porte sur la nouvelle tentative de paiement en cas d’échec.',
        'Les critères d’acceptation ne sont pas clairs.',
        'Le contrat d’API est déjà figé.',
        'Une démonstration est prévue jeudi.',
      ],
      objectives: [
        {
          id: 'state-confusion',
          description: 'Dire quelle partie de la tâche n’est pas claire.',
          successCriteria: ['Nomme le billet', 'Nomme le critère flou'],
        },
        {
          id: 'ask-question',
          description: 'Poser une question de clarification concrète.',
          successCriteria: [
            'Pose une question à laquelle le collègue peut répondre',
            'Reste sur la tâche',
          ],
        },
        {
          id: 'confirm-understanding',
          description: 'Reformuler l’interprétation convenue.',
          successCriteria: [
            'Résume le comportement attendu',
            'Confirme la contrainte de la démonstration',
          ],
        },
      ],
      opening: {
        personaId: 'peer',
        situation:
          'Tu ranges tes affaires après la rencontre du matin quand ton collègue t’interroge sur le billet.',
      },
      scriptedUser: scriptedUser('standup-fr-ca', 'fr', 'fr-CA', [
        'Je ne suis pas certain d’avoir saisi les critères d’acceptation de PAY-214. Tu peux préciser ce qui compte comme terminé ?',
        'Donc un paiement qui échoue deux fois doit être retenté automatiquement, mais seulement avant la démonstration ? Et après ?',
        'Est-ce que je dois aussi afficher le nombre de tentatives dans l’interface, ou c’est hors du périmètre pour jeudi ?',
        'Correct. Je mets en place les nouvelles tentatives automatiques avant la démonstration et je garde le compteur en interne pour l’instant.',
      ]),
      successCriteria: [
        'L’apprenant utilise un vocabulaire québécois naturel (par exemple billet, rencontre, correct).',
        'L’apprenant nomme le billet et le critère d’acceptation flou.',
        'L’apprenant confirme l’interprétation et la contrainte de la démonstration de jeudi.',
      ],
    },
  },
})
