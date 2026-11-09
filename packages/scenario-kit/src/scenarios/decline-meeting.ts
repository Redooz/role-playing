import { defineScenario } from '../scenario.js'
import { scriptedUser } from './helpers.js'

/**
 * External client asks to move a meeting; the learner must decline the proposed
 * slot and offer a workable alternative.
 *
 * The client is formal, diplomatic and politely impatient. `fr-CA` keeps the
 * formal register but uses Québécois business vocabulary.
 */
export const declineMeetingScenario = defineScenario({
  id: 'decline-meeting-invitation',
  version: '1.0.0',
  domain: 'workplace',
  scenarioType: 'decline-meeting-invitation',
  cefrBand: 'B2',
  variants: {
    en: {
      lang: 'en',
      locale: 'en',
      setting: 'A short call with an external client about a meeting invitation.',
      learnerRole: 'An account manager responsible for the client relationship.',
      personaIds: ['client'],
      facts: [
        'The client wants to move the meeting to tomorrow at 9.',
        'The learner has a conflicting deadline for another client.',
        'Thursday at 10 is available.',
        'The client needs an answer today.',
        'The client will not accept a vague answer; the learner must name a specific alternative.',
      ],
      objectives: [
        {
          id: 'decline-clearly',
          description: 'Decline the proposed slot clearly and politely.',
          successCriteria: ['Says no to tomorrow at 9', 'Avoids a vague maybe'],
        },
        {
          id: 'offer-alternative',
          description: 'Offer a concrete alternative.',
          successCriteria: ['Names a specific day and time', 'Checks that it works for the client'],
        },
        {
          id: 'protect-relationship',
          description: 'Keep the relationship constructive.',
          successCriteria: ['Acknowledges the client’s urgency', 'Confirms the next step'],
        },
      ],
      opening: {
        personaId: 'client',
        situation:
          'You have called to move tomorrow morning’s meeting and you need an answer today.',
      },
      scriptedUser: scriptedUser('decline-en', 'en', 'en', [
        "I'm afraid tomorrow at 9 doesn't work for me. Could we look at Thursday instead?",
        'Thursday at 10 is available. I can confirm that in writing today.',
        "I understand the urgency. I'll send the invitation for Thursday at 10.",
        "I'll send it now. Please accept it this afternoon.",
      ]),
      successCriteria: [
        'The learner declines tomorrow at 9 without pretending to be available.',
        'The learner offers a specific alternative and confirms it.',
        'The learner acknowledges the client’s urgency and agrees the next step.',
      ],
    },
    'en-GB': {
      lang: 'en',
      locale: 'en-GB',
      setting: 'A short call with an external client about a meeting invitation.',
      learnerRole: 'An account manager responsible for the client relationship.',
      personaIds: ['client'],
      facts: [
        'The client would like to move the meeting to tomorrow at 9.',
        'The learner has a conflicting deadline for another client.',
        'Thursday at 10 is available.',
        'The client needs an answer today.',
        'The client will not accept a vague answer; the learner must name a specific alternative.',
      ],
      objectives: [
        {
          id: 'decline-clearly',
          description: 'Decline the proposed slot clearly and politely.',
          successCriteria: ['Says no to tomorrow at 9', 'Avoids a vague maybe'],
        },
        {
          id: 'offer-alternative',
          description: 'Offer a concrete alternative.',
          successCriteria: ['Names a specific day and time', 'Checks that it suits the client'],
        },
        {
          id: 'protect-relationship',
          description: 'Keep the relationship constructive.',
          successCriteria: ['Acknowledges the client’s urgency', 'Confirms the next step'],
        },
      ],
      opening: {
        personaId: 'client',
        situation:
          'You have called to move tomorrow morning’s meeting and you need an answer today.',
      },
      scriptedUser: scriptedUser('decline-en-gb', 'en', 'en-GB', [
        "I'm afraid tomorrow at 9 doesn't suit me. Could we look at Thursday instead?",
        'Thursday at 10 is available. I can confirm that in writing today.',
        "I appreciate the urgency. I'll send the invitation for Thursday at 10.",
        "I'll send it now. Please accept it this afternoon.",
      ]),
      successCriteria: [
        'The learner uses natural British phrasing (for example suit you, rather difficult, in writing).',
        'The learner declines tomorrow at 9 and offers a specific alternative.',
        'The learner acknowledges the client’s urgency and agrees the next step.',
      ],
    },
    fr: {
      lang: 'fr',
      locale: 'fr',
      setting: 'Un court appel avec un client externe au sujet d’une invitation à une réunion.',
      learnerRole: 'Un chargé de compte responsable de la relation client.',
      personaIds: ['client'],
      facts: [
        'Le client veut déplacer la réunion à demain 9 h.',
        'L’apprenant a une échéance conflictuelle pour un autre client.',
        'Jeudi à 10 h est disponible.',
        'Le client a besoin d’une réponse aujourd’hui.',
        'Le client n’accepte pas une réponse vague ; l’apprenant doit proposer une solution précise.',
      ],
      objectives: [
        {
          id: 'decline-clearly',
          description: 'Refuser le créneau proposé clairement et poliment.',
          successCriteria: ['Refuse demain 9 h', 'Évite un peut-être vague'],
        },
        {
          id: 'offer-alternative',
          description: 'Proposer une solution de rechange concrète.',
          successCriteria: [
            'Nomme un jour et une heure précis',
            'Vérifie que cela convient au client',
          ],
        },
        {
          id: 'protect-relationship',
          description: 'Préserver la relation.',
          successCriteria: ['Reconnaît l’urgence du client', 'Confirme la prochaine étape'],
        },
      ],
      opening: {
        personaId: 'client',
        situation:
          'Vous appelez pour déplacer la réunion de demain matin et vous avez besoin d’une réponse aujourd’hui.',
      },
      scriptedUser: scriptedUser('decline-fr', 'fr', 'fr', [
        'Demain 9 h ne me convient pas, malheureusement. Pouvons-nous regarder jeudi à la place ?',
        'Jeudi à 10 h est disponible. Je peux vous le confirmer par écrit aujourd’hui.',
        'Je comprends votre urgence. Je vous envoie l’invitation pour jeudi à 10 h.',
        'Je vous l’envoie tout de suite. Merci de l’accepter cet après-midi.',
      ]),
      successCriteria: [
        'L’apprenant refuse demain 9 h sans laisser entendre qu’il est disponible.',
        'L’apprenant propose une autre solution précise et la confirme.',
        'L’apprenant reconnaît l’urgence du client et convient de la prochaine étape.',
      ],
    },
    'fr-CA': {
      lang: 'fr',
      locale: 'fr-CA',
      setting:
        'Un court appel avec un client externe au sujet d’une invitation à une rencontre. Le registre reste formel et le vocabulaire est québécois.',
      learnerRole: 'Un chargé de compte responsable de la relation client.',
      personaIds: ['client'],
      facts: [
        'Le client veut déplacer la rencontre à demain 9 h.',
        'L’apprenant a une échéance conflictuelle pour un autre client.',
        'Jeudi à 10 h est disponible.',
        'Le client a besoin d’une réponse aujourd’hui.',
        'Le client n’accepte pas une réponse vague ; l’apprenant doit proposer une solution précise.',
      ],
      objectives: [
        {
          id: 'decline-clearly',
          description: 'Refuser le créneau proposé clairement et poliment.',
          successCriteria: ['Refuse demain 9 h', 'Évite un peut-être vague'],
        },
        {
          id: 'offer-alternative',
          description: 'Proposer une solution de rechange concrète.',
          successCriteria: [
            'Nomme un jour et une heure précis',
            'Vérifie que cela convient au client',
          ],
        },
        {
          id: 'protect-relationship',
          description: 'Préserver la relation.',
          successCriteria: ['Reconnaît l’urgence du client', 'Confirme la prochaine étape'],
        },
      ],
      opening: {
        personaId: 'client',
        situation:
          'Vous appelez pour déplacer la rencontre de demain matin et vous avez besoin d’une réponse aujourd’hui.',
      },
      scriptedUser: scriptedUser('decline-fr-ca', 'fr', 'fr-CA', [
        'Demain 9 h ne me convient pas, malheureusement. Peut-on regarder jeudi à la place ?',
        'Jeudi à 10 h est libre. Je peux vous le confirmer par courriel aujourd’hui.',
        'Je comprends l’urgence. Je vous envoie l’invitation pour jeudi à 10 h.',
        'Je vous l’envoie tout de suite. Merci de l’accepter cet après-midi.',
      ]),
      successCriteria: [
        'L’apprenant utilise un vocabulaire québécois naturel (par exemple rencontre, courriel, conseil).',
        'L’apprenant refuse demain 9 h et propose une autre solution précise.',
        'L’apprenant reconnaît l’urgence du client et convient de la prochaine étape.',
      ],
    },
  },
})
