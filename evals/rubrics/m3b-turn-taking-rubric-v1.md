# M3b turn-taking rubric v1

Version: `m3b-turn-taking-rubric-v1`
Grader: Jev `typesafe/jev-1.14` via OpenRouter, one atomic yes/no per
intervention. No composite score. The line is **0.75**, matching the M2 grader;
it is a measurement line, not an adopted routing policy.

This rubric is provisional until the D6 calibration run. It covers only the
shadow and capability evidence for M3b; it never changes a live session.

## `turn_taking.interruption_warranted`

**English question:** Would an interjection by the candidate persona be clearly
warranted now, while the active persona is replying?

| Answer | Evidence                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| yes    | A specific, urgent contribution: corrects a misunderstanding, answers a direct address, or prevents a concrete error. |
| no     | The interjection would repeat, distract, or add nothing that cannot wait for the next turn.                           |

**French question:** Est-ce qu’une interjection de la personne candidate serait
clairement justifiée maintenant, pendant la réponse de la personne active ?

| Réponse | Preuve                                                                                                         |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| oui     | Un apport précis et urgent : corrige un malentendu, répond à une adresse directe ou évite une erreur concrète. |
| non     | L’interjection répéterait, distrairait ou n’apporterait rien qui ne puisse attendre la prochaine réplique.     |

The state contains only the public conversation, the committed learner
utterance, both public persona records and the active partial reply. It never
contains gold labels, arm ids, policy outcomes or the transcript's private
content. A failed Jev call makes the run incomplete; it is never a "no" or a
zero.

French and English are judged separately. Passing in one language does not
count for the other. The rubric stays `provisional` until blind human
double-labelling, not because the wording is unfinished.
