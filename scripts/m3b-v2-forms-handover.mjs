/**
 * Surface forms for `post-demo-handover` in the M3c P5 dataset.
 *
 * Counts are exact for one language: S5 8, S6 9, D1 5, Q1 2, Q2 6, Q3 5,
 * Q4 5, mixed 4. Each entry is used once per language.
 * `evidence` is a scenario fact index; the generator writes the fact text into
 * the golden note so the ownership is visible.
 */
const FACT = (index) => ({ kind: 'fact', index })

export const handoverForms = {
  en: {
    'TT-S5': [
      {
        text: 'How do we keep the client informed about the rollout?',
        owner: 'manager',
        evidence: FACT(2),
      },
      {
        text: 'Who should update the client after the demo?',
        owner: 'manager',
        evidence: FACT(2),
      },
      {
        text: 'What do we tell the client about the rollout date?',
        owner: 'manager',
        evidence: FACT(2),
      },
      {
        text: "How should we handle the client's follow-up questions?",
        owner: 'manager',
        evidence: FACT(2),
      },
      {
        text: 'When should we send the client an update?',
        owner: 'manager',
        evidence: FACT(2),
      },
      {
        text: 'How do we explain the rollout plan to the client?',
        owner: 'manager',
        evidence: FACT(2),
      },
      {
        text: 'Who is speaking to the client about the next steps?',
        owner: 'manager',
        evidence: FACT(2),
      },
      {
        text: 'What is the client message for the rollout?',
        owner: 'manager',
        evidence: FACT(2),
      },
    ],
    'TT-S6': [
      {
        text: 'Katherine, what should I do before the next demo?',
        owner: 'manager',
        evidence: FACT(4),
      },
      {
        text: 'Sam, what should I do about the action list?',
        owner: 'peer',
        evidence: FACT(5),
      },
      {
        text: 'What should I update on the rollout summary before Friday?',
        owner: 'manager',
        evidence: FACT(3),
      },
      {
        text: 'Who should I ask about the follow-up notes?',
        owner: 'peer',
        evidence: FACT(1),
      },
      {
        text: 'What is the next step on the action list?',
        owner: 'peer',
        evidence: FACT(5),
      },
      {
        text: 'Katherine, what should I prepare for the client call?',
        owner: 'manager',
        evidence: FACT(4),
      },
      {
        text: 'Sam, what should I do about the open actions?',
        owner: 'peer',
        evidence: FACT(5),
      },
      {
        text: 'What should I update on the rollout summary?',
        owner: 'manager',
        evidence: FACT(3),
      },
      {
        text: 'What is the next step on the follow-up notes?',
        owner: 'peer',
        evidence: FACT(1),
      },
    ],
    'TT-D1': [
      {
        text: 'Katherine, which follow-up actions are still open?',
        owner: 'peer',
        named: 'manager',
        evidence: FACT(5),
      },
      {
        text: 'Sam, who owns client communication?',
        owner: 'manager',
        named: 'peer',
        evidence: FACT(2),
      },
      {
        text: 'Kate, what is the status of the follow-up notes?',
        owner: 'peer',
        named: 'manager',
        evidence: FACT(1),
      },
      {
        text: 'Sam, what do we tell the client about the rollout?',
        owner: 'manager',
        named: 'peer',
        evidence: FACT(2),
      },
      {
        text: 'Katherine, what is the next step on the action list?',
        owner: 'peer',
        named: 'manager',
        evidence: FACT(5),
      },
    ],
    'TT-Q1': [
      { text: 'Katherine, understood, thank you.', reason: 'closing move with a name' },
      { text: 'Got it, thanks.', reason: 'closing move' },
    ],
    'TT-Q2': [
      { text: 'I wonder whether the client will notice the change.', reason: 'thinking aloud' },
      { text: 'The release date might slip if we rush this.', reason: 'thinking aloud' },
      { text: 'I am not sure the export is as small as we think.', reason: 'thinking aloud' },
      { text: 'This feels like a lot to absorb before Friday.', reason: 'thinking aloud' },
      { text: 'I think the demo went better than expected.', reason: 'thinking aloud' },
      { text: 'The client seemed quieter than usual.', reason: 'thinking aloud' },
    ],
    'TT-Q3': [
      {
        text: 'Should I update the action list? Yes, I will do that now.',
        reason: 'self-answer',
      },
      {
        text: 'Do I need to tell the client? No, Katherine is handling that.',
        reason: 'self-answer',
      },
      { text: 'Should I wait for the notes? I think I should wait.', reason: 'self-answer' },
      {
        text: 'Is the follow-up ready? Not yet, so I will check it.',
        reason: 'self-answer',
      },
      {
        text: 'Do I need to rewrite the summary? No, it is already done.',
        reason: 'self-answer',
      },
    ],
    'TT-Q4': [
      { text: 'The room is warm after the demo.', reason: 'side comment' },
      { text: 'My coffee has gone cold again.', reason: 'side comment' },
      { text: 'The train was late this morning.', reason: 'side comment' },
      { text: 'This room is always booked at this hour.', reason: 'side comment' },
      { text: 'The window will not close properly.', reason: 'side comment' },
    ],
    mixed: [
      {
        text: 'I can start the follow-up notes now, unless you want to add something.',
        owner: 'peer',
        evidence: FACT(1),
      },
      {
        text: 'I have the action list ready whenever you want it.',
        owner: 'peer',
        evidence: FACT(5),
      },
      {
        text: 'I can send the rollout summary today if that works.',
        owner: 'manager',
        evidence: FACT(3),
      },
      {
        text: 'I can draft the client update and share it, if that is useful.',
        owner: 'manager',
        evidence: FACT(2),
      },
    ],
  },
  fr: {
    'TT-S5': [
      {
        text: 'Comment tenir le client informé du déploiement ?',
        owner: 'manager',
        evidence: FACT(2),
      },
      {
        text: 'Qui doit mettre le client à jour après la démo ?',
        owner: 'manager',
        evidence: FACT(2),
      },
      {
        text: "Qu'est-ce qu'on dit au client sur la date de déploiement ?",
        owner: 'manager',
        evidence: FACT(2),
      },
      {
        text: 'Comment répondre aux questions de suivi du client ?',
        owner: 'manager',
        evidence: FACT(2),
      },
      {
        text: 'Quand faut-il envoyer une mise à jour au client ?',
        owner: 'manager',
        evidence: FACT(2),
      },
      {
        text: 'Comment expliquer le plan de déploiement au client ?',
        owner: 'manager',
        evidence: FACT(2),
      },
      {
        text: 'Qui parle au client des prochaines étapes ?',
        owner: 'manager',
        evidence: FACT(2),
      },
      {
        text: 'Quel est le message pour le client sur le déploiement ?',
        owner: 'manager',
        evidence: FACT(2),
      },
    ],
    'TT-S6': [
      {
        text: "Catherine, qu'est-ce que je dois faire avant la prochaine démo ?",
        owner: 'manager',
        evidence: FACT(4),
      },
      {
        text: "Samir, qu'est-ce que je dois faire pour la liste d'actions ?",
        owner: 'peer',
        evidence: FACT(5),
      },
      {
        text: 'Qu’est-ce que je dois mettre à jour dans le résumé de déploiement avant vendredi ?',
        owner: 'manager',
        evidence: FACT(3),
      },
      {
        text: 'À qui dois-je demander les notes de suivi ?',
        owner: 'peer',
        evidence: FACT(1),
      },
      {
        text: "Quelle est la prochaine étape pour la liste d'actions ?",
        owner: 'peer',
        evidence: FACT(5),
      },
      {
        text: "Catherine, qu'est-ce que je dois préparer pour l'appel client ?",
        owner: 'manager',
        evidence: FACT(4),
      },
      {
        text: "Samir, qu'est-ce que je dois faire pour les actions ouvertes ?",
        owner: 'peer',
        evidence: FACT(5),
      },
      {
        text: 'Qu’est-ce que je dois mettre à jour dans le résumé de déploiement ?',
        owner: 'manager',
        evidence: FACT(3),
      },
      {
        text: 'Quelle est la prochaine étape pour les notes de suivi ?',
        owner: 'peer',
        evidence: FACT(1),
      },
    ],
    'TT-D1': [
      {
        text: 'Catherine, quelles actions de suivi sont encore ouvertes ?',
        owner: 'peer',
        named: 'manager',
        evidence: FACT(5),
      },
      {
        text: 'Samir, qui est responsable de la communication client ?',
        owner: 'manager',
        named: 'peer',
        evidence: FACT(2),
      },
      {
        text: 'Catherine, quel est le statut des notes de suivi ?',
        owner: 'peer',
        named: 'manager',
        evidence: FACT(1),
      },
      {
        text: "Samir, qu'est-ce qu'on dit au client sur le déploiement ?",
        owner: 'manager',
        named: 'peer',
        evidence: FACT(2),
      },
      {
        text: "Catherine, quelle est la prochaine étape pour la liste d'actions ?",
        owner: 'peer',
        named: 'manager',
        evidence: FACT(5),
      },
    ],
    'TT-Q1': [
      { text: 'Catherine, compris, merci.', reason: 'closing move with a name' },
      { text: "D'accord, merci.", reason: 'closing move' },
    ],
    'TT-Q2': [
      {
        text: 'Je me demande si le client va remarquer le changement.',
        reason: 'thinking aloud',
      },
      {
        text: 'La date de livraison risque de glisser si on accélère.',
        reason: 'thinking aloud',
      },
      {
        text: "Je ne suis pas sûr que l'export soit si petit que ça.",
        reason: 'thinking aloud',
      },
      { text: 'Ça fait beaucoup à absorber avant vendredi.', reason: 'thinking aloud' },
      {
        text: "Je trouve que la démo s'est mieux passée que prévu.",
        reason: 'thinking aloud',
      },
      { text: 'Le client semblait plus silencieux que d’habitude.', reason: 'thinking aloud' },
    ],
    'TT-Q3': [
      {
        text: "Je dois mettre la liste d'actions à jour ? Oui, je le fais maintenant.",
        reason: 'self-answer',
      },
      {
        text: "Dois-je prévenir le client ? Non, Catherine s'en occupe.",
        reason: 'self-answer',
      },
      { text: 'Je dois attendre les notes ? Je pense que oui.', reason: 'self-answer' },
      { text: 'Le suivi est prêt ? Pas encore, je vais vérifier.', reason: 'self-answer' },
      { text: 'Dois-je réécrire le résumé ? Non, il est déjà fait.', reason: 'self-answer' },
    ],
    'TT-Q4': [
      { text: 'La salle est chaude après la démo.', reason: 'side comment' },
      { text: 'Mon café a encore refroidi.', reason: 'side comment' },
      { text: 'Le train était en retard ce matin.', reason: 'side comment' },
      { text: 'Cette salle est toujours prise à cette heure-ci.', reason: 'side comment' },
      { text: 'La fenêtre ne ferme pas correctement.', reason: 'side comment' },
    ],
    mixed: [
      {
        text: 'Je peux commencer les notes de suivi maintenant, sauf si tu veux ajouter quelque chose.',
        owner: 'peer',
        evidence: FACT(1),
      },
      {
        text: "J'ai la liste d'actions prête quand tu en as besoin.",
        owner: 'peer',
        evidence: FACT(5),
      },
      {
        text: 'Je peux envoyer le résumé de déploiement aujourd’hui si ça te va.',
        owner: 'manager',
        evidence: FACT(3),
      },
      {
        text: "Je peux préparer la mise à jour client et la partager, si c'est utile.",
        owner: 'manager',
        evidence: FACT(2),
      },
    ],
  },
}
