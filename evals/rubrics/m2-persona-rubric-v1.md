# M2 persona rubric v1

Version: `m2-persona-rubric-v1`
Grader: Jev `typesafe/jev-1.14` via OpenRouter, default 0.50 line.
One atomic yes/no judgment per axis per trial. No composite score.

| Axis                   | Question                                                             | Passing evidence                                             |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| `persona.consistency`  | Do all persona replies stay in the same professional role and voice? | Stable role, tone and boundaries across every turn.          |
| `language.quality`     | Are the replies in correct target-language English/French?           | Fluent grammar and vocabulary; no serious error.             |
| `register.fit`         | Is the register appropriate for the workplace relationship?          | Manager direct, peer informal, client formal and diplomatic. |
| `response.clarity`     | Are the replies clear and concise rather than rambling?              | Understandable and reasonably short.                         |
| `objective.completion` | Do the replies help the learner complete the scenario objective?     | A realistic opening and responsive turns.                    |
| `locale.fit`           | Do the replies match the stated `en-GB`/`fr-CA` locale?              | Locale-specific spelling, vocabulary and workplace norms.    |

Locale fit is judged only in the `m2-locale-variants` probe. English and French
questions are written separately in the target language. A failed Jev call makes
the run incomplete; it is never a "no" or a zero.

Human labels follow `m2-annotation-guideline-v1`. A `4` or `5` maps to `yes`;
`1`–`3` maps to `no`. Entries stay `draft` until at least two annotators
measure agreement; only then may they be `stable`.
