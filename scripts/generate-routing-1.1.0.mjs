#!/usr/bin/env node
/**
 * Author `synthetic-routing/1.1.0` (M3c P4).
 *
 * The dataset is two-sided by construction: every language and split carries
 * 22 speak-required, 14 silence-required and 4 mixed decisions. The family
 * counts are pinned in `evals/tasks/synthetic-routing/1.1.0/composition.json`
 * and re-derived here, so the committed files and the declaration cannot drift.
 *
 * Two kinds of content feed the tasks:
 *
 * - Topic templates (`TOPICS`) expand the regular families across five
 *   workplace topics and several surface forms.
 * - Hand-written negatives (`NEGATIVES`) carry the state that decides the
 *   label: a named non-owner, a closing move with a name inside it, a covered
 *   question whose answer is visible, and self-directed reasoning that mentions
 *   a topic keyword. The generator does not synthesise those states.
 *
 * Run it with `node scripts/generate-routing-1.1.0.mjs`. It is deterministic:
 * no clock, no RNG, and it never rewrites `1.0.0`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'prettier'

const DATASET = 'synthetic-routing'
const VERSION = '1.1.0'
const LANGS = ['en', 'fr']
const SPLITS = ['calibration', 'holdout']

/**
 * Pre-registered counts. The two splits differ only in the distractor count:
 * holdout carries six named non-owners, calibration four.
 */
export const DISTRIBUTION = {
  calibration: {
    'RT-S1': 5,
    'RT-S2': 4,
    'RT-S3': 4,
    'RT-S4': 5,
    'RT-D1': 4,
    'RT-Q1': 5,
    'RT-Q2': 4,
    'RT-Q3': 2,
    'RT-Q4': 3,
    mixed: 4,
  },
  holdout: {
    'RT-S1': 5,
    'RT-S2': 4,
    'RT-S3': 3,
    'RT-S4': 4,
    'RT-D1': 6,
    'RT-Q1': 5,
    'RT-Q2': 4,
    'RT-Q3': 2,
    'RT-Q4': 3,
    mixed: 4,
  },
}

const SPEAK_FAMILIES = new Set(['RT-S1', 'RT-S2', 'RT-S3', 'RT-S4', 'RT-D1'])

/** Five topics. Each one supplies a manager, peer and client objective. */
export const TOPICS = [
  {
    slug: 'budget',
    en: {
      brief: 'the budget review',
      m: 'the budget',
      p: 'the cost forecast',
      c: 'the pricing',
      manager: {
        goal: 'manager_goal',
        description: 'Own the budget review.',
        keywords: ['budget'],
      },
      peer: {
        goal: 'peer_goal',
        description: 'Handle the cost forecast.',
        keywords: ['cost forecast'],
      },
      client: { goal: 'client_goal', description: 'Resolve the pricing.', keywords: ['pricing'] },
      opening: 'We need to keep the budget review moving.',
      peerOpening: 'I picked up the notes from yesterday.',
      answer: 'The budget is approved for this quarter.',
      peerAnswer: 'The cost forecast is ready.',
      clientAnswer: 'The pricing is agreed.',
    },
    fr: {
      brief: 'la revue du budget',
      m: 'le budget',
      p: 'les prévisions de coûts',
      c: 'le prix',
      manager: {
        goal: 'manager_goal',
        description: 'Piloter la revue du budget.',
        keywords: ['budget'],
      },
      peer: {
        goal: 'peer_goal',
        description: 'Suivre les prévisions de coûts.',
        keywords: ['prévisions de coûts'],
      },
      client: { goal: 'client_goal', description: 'Régler le prix.', keywords: ['prix'] },
      opening: 'Il faut faire avancer la revue du budget.',
      peerOpening: "J'ai repris les notes d'hier.",
      answer: 'Le budget est validé pour ce trimestre.',
      peerAnswer: 'Les prévisions de coûts sont prêtes.',
      clientAnswer: 'Le prix est accepté.',
    },
  },
  {
    slug: 'onboarding',
    en: {
      brief: 'the onboarding plan',
      m: 'the onboarding plan',
      p: 'the onboarding checklist',
      c: 'the start date',
      manager: {
        goal: 'manager_goal',
        description: 'Own the onboarding plan.',
        keywords: ['onboarding plan'],
      },
      peer: {
        goal: 'peer_goal',
        description: 'Handle the onboarding checklist.',
        keywords: ['onboarding checklist'],
      },
      client: {
        goal: 'client_goal',
        description: 'Resolve the start date.',
        keywords: ['start date'],
      },
      opening: 'We need to keep the onboarding plan moving.',
      peerOpening: 'I picked up the notes from yesterday.',
      answer: 'The onboarding plan is approved.',
      peerAnswer: 'The onboarding checklist is complete.',
      clientAnswer: 'The start date is confirmed.',
    },
    fr: {
      brief: "le plan d'intégration",
      m: "le plan d'intégration",
      p: "la checklist d'intégration",
      c: 'la date de démarrage',
      manager: {
        goal: 'manager_goal',
        description: "Piloter le plan d'intégration.",
        keywords: ["plan d'intégration"],
      },
      peer: {
        goal: 'peer_goal',
        description: "Suivre la checklist d'intégration.",
        keywords: ["checklist d'intégration"],
      },
      client: {
        goal: 'client_goal',
        description: 'Régler la date de démarrage.',
        keywords: ['date de démarrage'],
      },
      opening: "Il faut faire avancer le plan d'intégration.",
      peerOpening: "J'ai repris les notes d'hier.",
      answer: "Le plan d'intégration est validé.",
      peerAnswer: "La checklist d'intégration est terminée.",
      clientAnswer: 'La date de démarrage est confirmée.',
    },
  },
  {
    slug: 'incident',
    en: {
      brief: 'the incident review',
      m: 'the incident review',
      p: 'the incident log',
      c: 'the service update',
      manager: {
        goal: 'manager_goal',
        description: 'Own the incident review.',
        keywords: ['incident review'],
      },
      peer: {
        goal: 'peer_goal',
        description: 'Handle the incident log.',
        keywords: ['incident log'],
      },
      client: {
        goal: 'client_goal',
        description: 'Resolve the service update.',
        keywords: ['service update'],
      },
      opening: 'We need to keep the incident review moving.',
      peerOpening: 'I picked up the notes from yesterday.',
      answer: 'The incident review is scheduled.',
      peerAnswer: 'The incident log is up to date.',
      clientAnswer: 'The service update is ready.',
    },
    fr: {
      brief: "la revue de l'incident",
      m: "la revue de l'incident",
      p: "le journal de l'incident",
      c: 'la mise à jour du service',
      manager: {
        goal: 'manager_goal',
        description: "Piloter la revue de l'incident.",
        keywords: ["revue de l'incident"],
      },
      peer: {
        goal: 'peer_goal',
        description: "Suivre le journal de l'incident.",
        keywords: ["journal de l'incident"],
      },
      client: {
        goal: 'client_goal',
        description: 'Régler la mise à jour du service.',
        keywords: ['mise à jour du service'],
      },
      opening: "Il faut faire avancer la revue de l'incident.",
      peerOpening: "J'ai repris les notes d'hier.",
      answer: "La revue de l'incident est planifiée.",
      peerAnswer: "Le journal de l'incident est à jour.",
      clientAnswer: 'La mise à jour du service est prête.',
    },
  },
  {
    slug: 'feedback',
    en: {
      brief: 'the feedback summary',
      m: 'the feedback summary',
      p: 'the survey results',
      c: 'the pilot review',
      manager: {
        goal: 'manager_goal',
        description: 'Own the feedback summary.',
        keywords: ['feedback summary'],
      },
      peer: {
        goal: 'peer_goal',
        description: 'Handle the survey results.',
        keywords: ['survey results'],
      },
      client: {
        goal: 'client_goal',
        description: 'Resolve the pilot review.',
        keywords: ['pilot review'],
      },
      opening: 'We need to keep the feedback summary moving.',
      peerOpening: 'I picked up the notes from yesterday.',
      answer: 'The feedback summary is ready.',
      peerAnswer: 'The survey results are in.',
      clientAnswer: 'The pilot review is booked.',
    },
    fr: {
      brief: 'la synthèse des retours',
      m: 'la synthèse des retours',
      p: "les résultats de l'enquête",
      c: 'la revue du pilote',
      manager: {
        goal: 'manager_goal',
        description: 'Piloter la synthèse des retours.',
        keywords: ['synthèse des retours'],
      },
      peer: {
        goal: 'peer_goal',
        description: "Suivre les résultats de l'enquête.",
        keywords: ["résultats de l'enquête"],
      },
      client: {
        goal: 'client_goal',
        description: 'Régler la revue du pilote.',
        keywords: ['revue du pilote'],
      },
      opening: 'Il faut faire avancer la synthèse des retours.',
      peerOpening: "J'ai repris les notes d'hier.",
      answer: 'La synthèse des retours est prête.',
      peerAnswer: "Les résultats de l'enquête sont arrivés.",
      clientAnswer: 'La revue du pilote est fixée.',
    },
  },
  {
    slug: 'travel',
    en: {
      brief: 'the travel budget',
      m: 'the travel budget',
      p: 'the booking sheet',
      c: 'the visit agenda',
      manager: {
        goal: 'manager_goal',
        description: 'Own the travel budget.',
        keywords: ['travel budget'],
      },
      peer: {
        goal: 'peer_goal',
        description: 'Handle the booking sheet.',
        keywords: ['booking sheet'],
      },
      client: {
        goal: 'client_goal',
        description: 'Resolve the visit agenda.',
        keywords: ['visit agenda'],
      },
      opening: 'We need to keep the travel budget moving.',
      peerOpening: 'I picked up the notes from yesterday.',
      answer: 'The travel budget is approved.',
      peerAnswer: 'The booking sheet is complete.',
      clientAnswer: 'The visit agenda is agreed.',
    },
    fr: {
      brief: 'le budget voyage',
      m: 'le budget voyage',
      p: 'le tableau des réservations',
      c: "l'ordre du jour de la visite",
      manager: {
        goal: 'manager_goal',
        description: 'Piloter le budget voyage.',
        keywords: ['budget voyage'],
      },
      peer: {
        goal: 'peer_goal',
        description: 'Suivre le tableau des réservations.',
        keywords: ['tableau des réservations'],
      },
      client: {
        goal: 'client_goal',
        description: "Régler l'ordre du jour de la visite.",
        keywords: ['ordre du jour de la visite'],
      },
      opening: 'Il faut faire avancer le budget voyage.',
      peerOpening: "J'ai repris les notes d'hier.",
      answer: 'Le budget voyage est validé.',
      peerAnswer: 'Le tableau des réservations est complet.',
      clientAnswer: "L'ordre du jour de la visite est accepté.",
    },
  },
]

/** The template families. Each form names the owner the label must accept. */
const FORMS = {
  en: {
    'RT-S1': [
      (t) => ({
        text: `Katherine, can you confirm ${t.m}?`,
        owner: 'manager',
        goal: 'manager_goal',
      }),
      (t) => ({ text: `Kate, where does ${t.m} stand?`, owner: 'manager', goal: 'manager_goal' }),
      (t) => ({ text: `Sam, can you update ${t.p}?`, owner: 'peer', goal: 'peer_goal' }),
      (t) => ({ text: `Julian, is ${t.c} ready?`, owner: 'client', goal: 'client_goal' }),
      (t) => ({
        text: `Katherine, what is the latest on ${t.m}?`,
        owner: 'manager',
        goal: 'manager_goal',
      }),
      (t) => ({
        text: `Sam, can you bring me up to speed on ${t.p}?`,
        owner: 'peer',
        goal: 'peer_goal',
      }),
    ],
    'RT-S2': [
      (t) => ({ text: `What is the latest on ${t.m}?`, owner: 'manager', goal: 'manager_goal' }),
      (t) => ({ text: `Where does ${t.m} stand?`, owner: 'manager', goal: 'manager_goal' }),
      (t) => ({ text: `Has ${t.p} been updated?`, owner: 'peer', goal: 'peer_goal' }),
      (t) => ({ text: `Is ${t.c} ready?`, owner: 'client', goal: 'client_goal' }),
      (t) => ({ text: `Can we confirm ${t.m}?`, owner: 'manager', goal: 'manager_goal' }),
      (t) => ({
        text: `Can someone give me the latest on ${t.p}?`,
        owner: 'peer',
        goal: 'peer_goal',
      }),
    ],
    'RT-S3': [
      (t) => ({
        text: `Actually, ${t.m} was approved yesterday, not last week.`,
        owner: 'manager',
        goal: 'manager_goal',
      }),
      (t) => ({
        text: `No, ${t.p} is due Thursday, not Friday.`,
        owner: 'peer',
        goal: 'peer_goal',
      }),
      (t) => ({
        text: `That is not right: ${t.c} is already agreed.`,
        owner: 'client',
        goal: 'client_goal',
      }),
      (t) => ({
        text: `${t.m} is not approved yet, so we cannot promise that date.`,
        owner: 'manager',
        goal: 'manager_goal',
      }),
      (t) => ({
        text: `${t.p} changed on Monday; the old version is out of date.`,
        owner: 'peer',
        goal: 'peer_goal',
      }),
    ],
    'RT-S4': [
      (t) => ({
        text: `Should we move ${t.m} to Friday?`,
        owner: 'manager',
        goal: 'manager_goal',
      }),
      (t) => ({ text: `Can we approve ${t.m} today?`, owner: 'manager', goal: 'manager_goal' }),
      (t) => ({ text: `Do you want to sign off on ${t.c}?`, owner: 'client', goal: 'client_goal' }),
      (t) => ({ text: `Should we close ${t.p} this week?`, owner: 'peer', goal: 'peer_goal' }),
      (t) => ({
        text: `Can we confirm ${t.m} before the meeting?`,
        owner: 'manager',
        goal: 'manager_goal',
      }),
    ],
    'RT-D1': [
      (t) => ({
        text: `Sam, what is the latest on ${t.m}?`,
        owner: 'manager',
        goal: 'manager_goal',
        named: 'peer',
      }),
      (t) => ({
        text: `Julian, can you confirm ${t.m}?`,
        owner: 'manager',
        goal: 'manager_goal',
        named: 'client',
      }),
      (t) => ({
        text: `Katherine, can you bring me up to speed on ${t.p}?`,
        owner: 'peer',
        goal: 'peer_goal',
        named: 'manager',
      }),
      (t) => ({
        text: `Julian, is ${t.p} ready?`,
        owner: 'peer',
        goal: 'peer_goal',
        named: 'client',
      }),
      (t) => ({
        text: `Sam, do you want to sign off on ${t.c}?`,
        owner: 'client',
        goal: 'client_goal',
        named: 'peer',
      }),
      (t) => ({
        text: `Katherine, should we move ${t.c} to Friday?`,
        owner: 'client',
        goal: 'client_goal',
        named: 'manager',
      }),
    ],
    'RT-Q1': [
      'Thanks, that helps.',
      'Understood, I will note that.',
      'Right, I have what I need.',
      'Got it, thanks.',
      'I will make a note of that.',
      'Sam, thanks, I will note that.',
      'Katherine, understood, thank you.',
      'That is clear, thank you.',
      'Noted, I will follow up.',
      'Perfect, I have everything.',
    ],
    'RT-Q2': [
      { text: (t) => `What was the final word on ${t.m}?`, owner: 'manager', goal: 'manager_goal' },
      { text: (t) => `What is the latest on ${t.p}?`, owner: 'peer', goal: 'peer_goal' },
      { text: (t) => `Has ${t.c} been settled?`, owner: 'client', goal: 'client_goal' },
      { text: (t) => `Has ${t.m} been approved?`, owner: 'manager', goal: 'manager_goal' },
      { text: (t) => `What is the status of ${t.p}?`, owner: 'peer', goal: 'peer_goal' },
      {
        text: (t) => `What is the current state of ${t.m}?`,
        owner: 'manager',
        goal: 'manager_goal',
      },
    ],
    'RT-Q3': [
      { text: (t) => `I think ${t.m} is the real problem here.`, goal: 'manager_goal' },
      { text: (t) => `Maybe we should have looked at ${t.p} earlier.`, goal: 'peer_goal' },
      { text: (t) => `${t.c} feels like the risky part.`, goal: 'client_goal' },
      { text: (t) => `I am not sure ${t.m} will hold.`, goal: 'manager_goal' },
    ],
    'RT-Q4': [
      'It is colder than I expected in here.',
      'The train was late again this morning.',
      'My coffee has gone cold.',
      'This room is always booked at this hour.',
      'The window will not close properly.',
      'I forgot my badge at home again.',
    ],
    mixed: [
      {
        text: (t) => `I can start work on ${t.m} now, unless you want to add something.`,
        owner: 'manager',
        goal: 'manager_goal',
      },
      {
        text: (t) => `I have ${t.p} ready whenever you want it.`,
        owner: 'peer',
        goal: 'peer_goal',
      },
      {
        text: (t) => `I can send ${t.c} today if that works.`,
        owner: 'client',
        goal: 'client_goal',
      },
      {
        text: (t) => `I can draft a note on ${t.m} and share it, if that is useful.`,
        owner: 'manager',
        goal: 'manager_goal',
      },
      {
        text: (t) => `I can wait for ${t.p} before I send anything.`,
        owner: 'peer',
        goal: 'peer_goal',
      },
    ],
  },
  fr: {
    'RT-S1': [
      (t) => ({
        text: `Katherine, pouvez-vous confirmer ${t.m} ?`,
        owner: 'manager',
        goal: 'manager_goal',
      }),
      (t) => ({ text: `Kate, où en est ${t.m} ?`, owner: 'manager', goal: 'manager_goal' }),
      (t) => ({
        text: `Sam, pouvez-vous mettre à jour ${t.p} ?`,
        owner: 'peer',
        goal: 'peer_goal',
      }),
      (t) => ({
        text: `Julian, pouvez-vous confirmer ${t.c} ?`,
        owner: 'client',
        goal: 'client_goal',
      }),
      (t) => ({
        text: `Katherine, quelle est la dernière information sur ${t.m} ?`,
        owner: 'manager',
        goal: 'manager_goal',
      }),
      (t) => ({
        text: `Sam, pouvez-vous faire le point sur ${t.p} ?`,
        owner: 'peer',
        goal: 'peer_goal',
      }),
    ],
    'RT-S2': [
      (t) => ({ text: `Où en est ${t.m} ?`, owner: 'manager', goal: 'manager_goal' }),
      (t) => ({
        text: `Quelle est la dernière information sur ${t.m} ?`,
        owner: 'manager',
        goal: 'manager_goal',
      }),
      (t) => ({ text: `Peut-on confirmer ${t.p} ?`, owner: 'peer', goal: 'peer_goal' }),
      (t) => ({ text: `Peut-on confirmer ${t.c} ?`, owner: 'client', goal: 'client_goal' }),
      (t) => ({ text: `Faut-il valider ${t.m} ?`, owner: 'manager', goal: 'manager_goal' }),
      (t) => ({ text: `Peut-on faire le point sur ${t.p} ?`, owner: 'peer', goal: 'peer_goal' }),
    ],
    'RT-S3': [
      (t) => ({
        text: `En fait, il y a une erreur sur ${t.m} : la décision date d'hier.`,
        owner: 'manager',
        goal: 'manager_goal',
      }),
      (t) => ({
        text: `Non, il y a un problème avec ${t.p} : la date a changé.`,
        owner: 'peer',
        goal: 'peer_goal',
      }),
      (t) => ({
        text: `Ce n'est pas ce qui est convenu pour ${t.c} : il faut corriger.`,
        owner: 'client',
        goal: 'client_goal',
      }),
      (t) => ({
        text: `Attention, il manque encore une validation sur ${t.m}, on ne peut pas promettre cette date.`,
        owner: 'manager',
        goal: 'manager_goal',
      }),
      (t) => ({
        text: `Il y a eu un changement sur ${t.p} lundi ; l'ancienne version n'est plus valable.`,
        owner: 'peer',
        goal: 'peer_goal',
      }),
    ],
    'RT-S4': [
      (t) => ({
        text: `Peut-on valider ${t.m} aujourd'hui ?`,
        owner: 'manager',
        goal: 'manager_goal',
      }),
      (t) => ({
        text: `Faut-il valider ${t.m} avant la réunion ?`,
        owner: 'manager',
        goal: 'manager_goal',
      }),
      (t) => ({
        text: `Peut-on valider ${t.c} cette semaine ?`,
        owner: 'client',
        goal: 'client_goal',
      }),
      (t) => ({ text: `Peut-on valider ${t.p} cette semaine ?`, owner: 'peer', goal: 'peer_goal' }),
      (t) => ({
        text: `Faut-il valider ${t.m} cette semaine ?`,
        owner: 'manager',
        goal: 'manager_goal',
      }),
    ],
    'RT-D1': [
      (t) => ({
        text: `Sam, où en est ${t.m} ?`,
        owner: 'manager',
        goal: 'manager_goal',
        named: 'peer',
      }),
      (t) => ({
        text: `Julian, pouvez-vous confirmer ${t.m} ?`,
        owner: 'manager',
        goal: 'manager_goal',
        named: 'client',
      }),
      (t) => ({
        text: `Katherine, pouvez-vous faire le point sur ${t.p} ?`,
        owner: 'peer',
        goal: 'peer_goal',
        named: 'manager',
      }),
      (t) => ({
        text: `Julian, peut-on confirmer ${t.p} ?`,
        owner: 'peer',
        goal: 'peer_goal',
        named: 'client',
      }),
      (t) => ({
        text: `Sam, peut-on valider ${t.c} ?`,
        owner: 'client',
        goal: 'client_goal',
        named: 'peer',
      }),
      (t) => ({
        text: `Katherine, peut-on valider ${t.c} ?`,
        owner: 'client',
        goal: 'client_goal',
        named: 'manager',
      }),
    ],
    'RT-Q1': [
      'Merci, ça aide.',
      'Compris, je prends note.',
      "Très bien, j'ai ce qu'il me faut.",
      "D'accord, merci.",
      'Je vais noter tout ça.',
      'Sam, merci, je prends note.',
      'Katherine, compris, merci.',
      "C'est clair, merci.",
      'Noté, je vais suivre le sujet.',
      "Parfait, j'ai tout ce qu'il faut.",
    ],
    'RT-Q2': [
      {
        text: (t) => `Quelle est la conclusion sur ${t.m} ?`,
        owner: 'manager',
        goal: 'manager_goal',
      },
      { text: (t) => `Quelle est la situation pour ${t.p} ?`, owner: 'peer', goal: 'peer_goal' },
      { text: (t) => `Quel est le point sur ${t.c} ?`, owner: 'client', goal: 'client_goal' },
      { text: (t) => `Où en est la décision sur ${t.m} ?`, owner: 'manager', goal: 'manager_goal' },
      { text: (t) => `Quel est le point sur ${t.p} ?`, owner: 'peer', goal: 'peer_goal' },
      {
        text: (t) => `Quel est le dernier point sur ${t.m} ?`,
        owner: 'manager',
        goal: 'manager_goal',
      },
    ],
    'RT-Q3': [
      { text: (t) => `Je pense que ${t.m} est le vrai problème.`, goal: 'manager_goal' },
      { text: (t) => `On aurait peut-être dû regarder ${t.p} plus tôt.`, goal: 'peer_goal' },
      { text: (t) => `${t.c}, c'est la partie risquée.`, goal: 'client_goal' },
      { text: (t) => `Je ne suis pas sûr que ${t.m} tienne.`, goal: 'manager_goal' },
    ],
    'RT-Q4': [
      'Il fait plus froid que prévu ici.',
      'Le train était encore en retard ce matin.',
      'Mon café a refroidi.',
      'Cette salle est toujours prise à cette heure-ci.',
      'La fenêtre ne ferme pas correctement.',
      "J'ai encore oublié mon badge chez moi.",
    ],
    mixed: [
      {
        text: (t) =>
          `Je peux commencer à travailler sur ${t.m} maintenant, sauf si vous voulez ajouter quelque chose.`,
        owner: 'manager',
        goal: 'manager_goal',
      },
      {
        text: (t) => `J'ai tout ce qu'il faut sur ${t.p} quand vous en avez besoin.`,
        owner: 'peer',
        goal: 'peer_goal',
      },
      {
        text: (t) => `Je peux envoyer ${t.c} aujourd'hui si ça vous va.`,
        owner: 'client',
        goal: 'client_goal',
      },
      {
        text: (t) => `Je peux préparer une note sur ${t.m} et la partager, si c'est utile.`,
        owner: 'manager',
        goal: 'manager_goal',
      },
      {
        text: (t) => `Je peux attendre ${t.p} avant d'envoyer quoi que ce soit.`,
        owner: 'peer',
        goal: 'peer_goal',
      },
    ],
  },
}

const PERSONAS = {
  en: [
    {
      id: 'manager',
      displayName: 'Katherine Brooks',
      aliases: ['Katherine', 'Kate'],
      role: 'manager',
    },
    { id: 'peer', displayName: 'Sam Carter', aliases: ['Sam'], role: 'peer colleague' },
    {
      id: 'client',
      displayName: 'Julian Moore',
      aliases: ['Julian', 'Mr Moore'],
      role: 'external client',
    },
  ],
  fr: [
    {
      id: 'manager',
      displayName: 'Katherine Brooks',
      aliases: ['Katherine', 'Kate'],
      role: 'responsable',
    },
    { id: 'peer', displayName: 'Sam Carter', aliases: ['Sam'], role: 'collègue' },
    {
      id: 'client',
      displayName: 'Julian Moore',
      aliases: ['Julian', 'Mr Moore'],
      role: 'client externe',
    },
  ],
}

const SPEAKER_IDS = {
  en: {
    calibration: 'speaker-routing-110-en-calibration',
    holdout: 'speaker-routing-110-en-holdout',
  },
  fr: {
    calibration: 'speaker-routing-110-fr-calibration',
    holdout: 'speaker-routing-110-fr-holdout',
  },
}

function personasFor(lang, topic) {
  const t = topic[lang]
  return PERSONAS[lang].map((persona) => {
    const spec = t[persona.id === 'manager' ? 'manager' : persona.id === 'peer' ? 'peer' : 'client']
    return {
      ...persona,
      objectives: [
        {
          id: spec.goal,
          description: spec.description,
          keywords: [...spec.keywords],
        },
      ],
    }
  })
}

function transcriptFor(lang, topic, options = {}) {
  const t = topic[lang]
  const turns = [
    { speaker: { kind: 'persona', personaId: 'manager' }, text: t.opening },
    { speaker: { kind: 'persona', personaId: 'peer' }, text: t.peerOpening },
  ]
  if (options.answer !== undefined) {
    turns.push({
      speaker: { kind: 'persona', personaId: options.answer.personaId },
      text: options.answer.text,
    })
  }
  turns.push({ speaker: { kind: 'user' }, text: options.utterance })
  return turns
}

function answerFor(lang, topic, owner) {
  const t = topic[lang]
  if (owner === 'manager') return { personaId: 'manager', text: t.answer }
  if (owner === 'peer') return { personaId: 'peer', text: t.peerAnswer }
  return { personaId: 'client', text: t.clientAnswer }
}

function ownerNote(owner, goal, keyword) {
  return `owner: ${owner}.objectives[${goal}] "${keyword}"`
}

/** A template can start with a topic phrase; the sentence still needs a capital. */
function capitalize(text, lang) {
  if (text.length === 0) return text
  return text[0].toLocaleUpperCase(lang) + text.slice(1)
}

/** The exact keyword that establishes the owner for a generated form. */
function keywordFor(topic, lang, goal) {
  const t = topic[lang]
  if (goal === 'manager_goal') return t.manager.keywords[0]
  if (goal === 'peer_goal') return t.peer.keywords[0]
  return t.client.keywords[0]
}

/**
 * Build one slice (language × split). `offset` shifts the topic cursor so the
 * two splits do not reuse the same topic/form pairs.
 */
function buildSlice(lang, split, offset) {
  const distribution = DISTRIBUTION[split]
  const forms = FORMS[lang]
  const tasks = []
  const goldens = []
  let cursor = offset
  let index = 0

  for (const [family, count] of Object.entries(distribution)) {
    for (let i = 0; i < count; i += 1) {
      const topic = TOPICS[cursor % TOPICS.length]
      cursor += 1
      const t = topic[lang]
      index += 1
      const id = `routing-${lang}-110-${split === 'calibration' ? 'cal' : 'hold'}-${String(index).padStart(3, '0')}`
      const goldenId = `golden-${id}`
      const form = forms[family]
      const item = form[(i + (split === 'holdout' ? count : 0)) % form.length]

      let utterance
      let acceptablePersonaIds = []
      let allowUserYield = false
      let note
      let distractor = false
      let answer
      let coveredObjectiveIds = []

      if (SPEAK_FAMILIES.has(family)) {
        const spec = typeof item === 'function' ? item(t) : item
        utterance = spec.text
        acceptablePersonaIds = [spec.owner]
        note = ownerNote(spec.owner, spec.goal, keywordFor(topic, lang, spec.goal))
        if (family === 'RT-D1') {
          distractor = true
          note = `${note}; named: ${spec.named}`
        }
      } else if (family === 'RT-Q1') {
        utterance = item
        allowUserYield = true
        note = 'closing: no request; no owner'
      } else if (family === 'RT-Q2') {
        const spec = item
        utterance = spec.text(t)
        allowUserYield = true
        const answerText = answerFor(lang, topic, spec.owner)
        answer = { personaId: answerText.personaId, text: answerText.text }
        coveredObjectiveIds = [spec.goal]
        note = `visible: transcript[2] "${answerText.text}"; covered: ${spec.goal}`
      } else if (family === 'RT-Q3') {
        const spec = item
        utterance = spec.text(t)
        allowUserYield = true
        note = `self-directed: no addressee; mentions ${spec.goal}`
      } else if (family === 'RT-Q4') {
        utterance = item
        allowUserYield = true
        note = 'aside: no eligible addressee'
      } else {
        const spec = item
        utterance = spec.text(t)
        acceptablePersonaIds = [spec.owner]
        allowUserYield = true
        note = `${ownerNote(spec.owner, spec.goal, keywordFor(topic, lang, spec.goal))}; learner may proceed`
      }

      utterance = capitalize(utterance, lang)
      const transcript = transcriptFor(lang, topic, { utterance, answer })
      const evidence =
        family === 'RT-Q2'
          ? [
              { turnIndex: 2, textRef: answer.text },
              { turnIndex: 3, textRef: utterance },
            ]
          : [{ turnIndex: transcript.length - 1, textRef: utterance }]
      const scenarioBrief =
        lang === 'en'
          ? `The learner is in a workplace conversation about ${t.brief}.`
          : `L'apprenant participe à une conversation professionnelle sur ${t.brief}.`

      tasks.push({
        id,
        lang,
        mode: 'routing',
        domain: 'workplace',
        scenarioType: topic.slug,
        cefrBand: 'B1',
        speakerId: SPEAKER_IDS[lang][split],
        split,
        provenance: { source: 'synthetic', note: 'M3c routing replay decision point' },
        consentScope: 'synthetic-no-consent-required',
        annotationVersions: {
          routingRubric: 'm3a-routing-rubric-v1',
          annotationGuideline: 'm3a-routing-label-v2',
        },
        content: { scenarioBrief, turns: [] },
        routing: {
          context: {
            decisionId: id,
            turnId: `${id}-turn`,
            lang,
            transcript,
            personas: personasFor(lang, topic),
            coveredObjectiveIds,
          },
        },
      })

      const familyName = family === 'mixed' ? 'mixed' : family
      goldens.push({
        id: goldenId,
        lang,
        split,
        taskId: id,
        routingOutcome: {
          intent: `${familyName.toLowerCase()}-${acceptablePersonaIds[0] ?? 'learner'}`,
          acceptablePersonaIds,
          allowUserYield,
          labelSource: 'agent',
          family: familyName,
          ...(distractor ? { distractor: true } : {}),
          note,
        },
        evidenceSpans: evidence,
        pairwisePreferences: [],
        status: 'draft',
        notes:
          'Agent label authored against m3a-routing-label-v2. Provisional, not human ground truth.',
      })
    }
  }

  return { tasks, goldens }
}

/** Build the whole dataset in memory. */
export function buildDataset() {
  const tasks = []
  const goldens = []
  for (const lang of LANGS) {
    for (const [splitIndex, split] of SPLITS.entries()) {
      const slice = buildSlice(lang, split, splitIndex * 1)
      tasks.push(...slice.tasks)
      goldens.push(...slice.goldens)
    }
  }
  return { tasks, goldens }
}

/** Per-language, per-split, per-family label counts. */
export function familyMatrix(goldens) {
  const matrix = {}
  for (const lang of LANGS) {
    matrix[lang] = {}
    for (const split of SPLITS) {
      const counts = {}
      for (const golden of goldens) {
        if (golden.lang !== lang || golden.split !== split) continue
        const family = golden.routingOutcome.family
        counts[family] = (counts[family] ?? 0) + 1
      }
      matrix[lang][split] = counts
    }
  }
  return matrix
}

/** Write the task and golden files. Existing files with the same id are replaced. */
export async function writeDataset(repoRoot) {
  const { tasks, goldens } = buildDataset()
  const taskRoot = join(repoRoot, 'evals/tasks', DATASET, VERSION)
  const goldenRoot = join(repoRoot, 'evals/golden')
  for (const task of tasks) {
    const path = join(taskRoot, task.lang, `${task.id}.json`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, await format(JSON.stringify(task, null, 2), { parser: 'json' }))
  }
  for (const golden of goldens) {
    const path = join(goldenRoot, golden.lang, VERSION, `${golden.taskId}.json`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, await format(JSON.stringify(golden, null, 2), { parser: 'json' }))
  }
  return { tasks: tasks.length, goldens: goldens.length }
}

const entry = fileURLToPath(import.meta.url)
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === entry

if (invokedDirectly) {
  const repoRoot = resolve(dirname(entry), '..')
  const { tasks, goldens } = await writeDataset(repoRoot)
  console.log(`wrote ${tasks} tasks and ${goldens} goldens for ${DATASET}/${VERSION}`)
}
