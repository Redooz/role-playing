/**
 * Surface forms for `standup-scope-change` in the M3c P5 dataset.
 *
 * Counts are exact for one language: S1 9, S2 8, S3 8, S4 8, D1 7, Q1 4.
 * Each entry is used once per language, so the learner never repeats a turn.
 * `evidence` names the scenario field that establishes the owner.
 */
const OBJECTIVE = (id, personaIds) => ({ kind: 'objective', id, personaIds })

export const standupForms = {
  en: {
    'TT-S1': [
      {
        text: 'Sam, how much of the notification work is already finished?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Sam, what is still at risk in the notification impact?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Katherine, does the export still ship on Friday?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: "Katherine, is Friday's release still going ahead?",
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Sam, which part of the notification work is already done?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Kate, what is the priority for Friday?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Sam, what still needs work on the alerting impact?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Katherine, is the release date still Friday?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Sam, how far along is the notification scope?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
    ],
    'TT-S2': [
      {
        text: 'Katherine, can you confirm the Friday priority?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Sam, can you take the impact check?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Katherine, can you confirm the export priority for Friday?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Sam, can you check what is at risk before Friday?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Katherine, can you take the Friday priority decision?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Sam, can you take the notification impact?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Kate, can you confirm the export scope?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Sam, can you review the notification risk?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
    ],
    'TT-S3': [
      {
        text: 'Can someone confirm the export priority for Friday?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Can someone confirm whether the export still ships on Friday?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Can someone explain the notification impact?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Can someone clarify the Friday priority?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Can someone explain what is at risk in the release?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Can someone explain the notification risk for Friday?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Can someone confirm the Friday priority?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Can someone clarify the notification risk?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
    ],
    'TT-S4': [
      {
        text: 'Who owns the impact assessment?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Whose call is the Friday priority?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Who is handling the notification impact?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Who decides what ships on Friday?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Who is responsible for the notification risk?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Who owns the export decision?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Who is looking after the impact check?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Who settles the Friday priority?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
    ],
    'TT-D1': [
      {
        text: 'Katherine, how much of the notification work is already finished?',
        owner: 'peer',
        named: 'manager',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Sam, does the export still ship on Friday?',
        owner: 'manager',
        named: 'peer',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Kate, what is at risk in the notification work?',
        owner: 'peer',
        named: 'manager',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: "Sam, is Friday's release still going ahead?",
        owner: 'manager',
        named: 'peer',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Katherine, which part of the notification work is done?',
        owner: 'peer',
        named: 'manager',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Sam, what is the Friday priority?',
        owner: 'manager',
        named: 'peer',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Kate, how far along is the notification impact?',
        owner: 'peer',
        named: 'manager',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
    ],
    'TT-Q1': [
      { text: 'Thanks, noted.', reason: 'closing move' },
      { text: 'Understood, I will note that.', reason: 'closing move' },
      { text: 'Right, I have what I need.', reason: 'closing move' },
      { text: 'Sam, thanks, I will note that.', reason: 'closing move with a name' },
    ],
  },
  fr: {
    'TT-S1': [
      {
        text: 'Samir, quelle part du travail sur les notifications est déjà terminée ?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: "Samir, qu'est-ce qui reste risqué dans l'impact sur les notifications ?",
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: "Catherine, est-ce que l'export part toujours vendredi ?",
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Catherine, la livraison de vendredi est-elle maintenue ?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Samir, quelle partie du travail sur les notifications est déjà faite ?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Catherine, quelle est la priorité pour vendredi ?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: "Samir, que reste-t-il à faire sur l'impact des alertes ?",
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Catherine, la date de livraison est-elle toujours vendredi ?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Samir, où en est le périmètre des notifications ?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
    ],
    'TT-S2': [
      {
        text: 'Catherine, peux-tu confirmer la priorité de vendredi ?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: "Samir, peux-tu vérifier l'impact ?",
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: "Catherine, peux-tu confirmer la priorité de l'export pour vendredi ?",
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Samir, peux-tu vérifier ce qui est risqué avant vendredi ?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Catherine, peux-tu prendre la décision sur la priorité de vendredi ?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: "Samir, peux-tu prendre l'impact des notifications ?",
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: "Catherine, peux-tu confirmer le périmètre de l'export ?",
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Samir, peux-tu revoir le risque sur les notifications ?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
    ],
    'TT-S3': [
      {
        text: "Quelqu'un peut-il confirmer la priorité de l'export pour vendredi ?",
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: "Quelqu'un peut-il confirmer si l'export part toujours vendredi ?",
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: "Quelqu'un peut-il expliquer l'impact sur les notifications ?",
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: "Quelqu'un peut-il clarifier la priorité de vendredi ?",
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: "Quelqu'un peut-il expliquer ce qui est risqué dans la livraison ?",
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: "Quelqu'un peut-il expliquer le risque sur les notifications pour vendredi ?",
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: "Quelqu'un peut-il confirmer la priorité de vendredi ?",
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: "Quelqu'un peut-il clarifier le risque sur les notifications ?",
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
    ],
    'TT-S4': [
      {
        text: "Qui est responsable de l'évaluation d'impact ?",
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'À qui revient la priorité de vendredi ?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: "Qui s'occupe de l'impact sur les notifications ?",
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Qui décide de ce qui part vendredi ?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Qui est responsable du risque sur les notifications ?',
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: "Qui possède la décision sur l'export ?",
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: "Qui suit l'évaluation d'impact ?",
        owner: 'peer',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Qui tranche la priorité de vendredi ?',
        owner: 'manager',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
    ],
    'TT-D1': [
      {
        text: 'Catherine, quelle part du travail sur les notifications est déjà terminée ?',
        owner: 'peer',
        named: 'manager',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: "Samir, est-ce que l'export part toujours vendredi ?",
        owner: 'manager',
        named: 'peer',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: "Catherine, qu'est-ce qui est risqué dans le travail sur les notifications ?",
        owner: 'peer',
        named: 'manager',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Samir, la livraison de vendredi est-elle maintenue ?',
        owner: 'manager',
        named: 'peer',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: 'Catherine, quelle partie du travail sur les notifications est faite ?',
        owner: 'peer',
        named: 'manager',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
      {
        text: 'Samir, quelle est la priorité de vendredi ?',
        owner: 'manager',
        named: 'peer',
        evidence: OBJECTIVE('agree-priority', ['manager']),
      },
      {
        text: "Catherine, où en est l'impact sur les notifications ?",
        owner: 'peer',
        named: 'manager',
        evidence: OBJECTIVE('assess-impact', ['peer']),
      },
    ],
    'TT-Q1': [
      { text: "Merci, c'est noté.", reason: 'closing move' },
      { text: 'Compris, je prends note.', reason: 'closing move' },
      { text: "Très bien, j'ai ce qu'il me faut.", reason: 'closing move' },
      { text: 'Samir, merci, je prends note.', reason: 'closing move with a name' },
    ],
  },
}
