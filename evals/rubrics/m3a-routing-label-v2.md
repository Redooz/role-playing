# M3a routing label guideline v2

Version: `m3a-routing-label-v2`
Applies to: `synthetic-routing/1.1.0` and later.
Frozen: `synthetic-routing/1.0.0` stays on its v1 label rule and is never edited.

This version adds the two rules the M3c P3 taxonomy found missing: a closing move
is not a request, and a covered-topic silence label is valid only when the answer
is visible in the transcript. It does not change the Jev question, the Jev
threshold or any arm.

## Unit

One `routingOutcome` per routing decision task. The label describes the next
turn at the committed learner utterance; it does not score a persona reply.

## Classes

| Class     | `acceptablePersonaIds` | `allowUserYield` | Meaning                                                   |
| --------- | ---------------------- | ---------------- | --------------------------------------------------------- |
| `speak`   | non-empty              | `false`          | At least one eligible persona must produce the next turn. |
| `silence` | empty                  | `true`           | The learner continues alone; no persona speaks.           |
| `mixed`   | non-empty              | `true`           | Either a persona reply or learner yield is acceptable.    |

A label that accepts neither a persona nor learner yield is invalid. `mixed` is
counted and reported but never folded into either class rate.

## Rules

Apply the first rule that matches. The order matters: a closing move is silence
even if it contains a topic keyword, and a covered question is silence only when
the answer is visible.

- **R1 — Closing move.** The utterance closes the turn and asks for no fact,
  decision or action: thanks, noted, understood, right, OK, "I'll make a note",
  "merci, je prends note", "d'accord", "compris", "c'est noté". Label `silence`.
  A name or a topic word inside a closing move does not turn it into a request.
- **R2 — Named owner.** The learner names an eligible persona and the topic is in
  that persona's scope. Label `speak` with that persona.
- **R3 — Uncovered objective.** The utterance matches an objective keyword that
  is not in `coveredObjectiveIds`. Label `speak` with the objective's owner.
- **R4 — Correction.** The learner corrects a misunderstanding or prevents a
  concrete error, and the owner is identifiable. Label `speak` with the owner,
  even when the owner is not named.
- **R5 — Covered question, visible answer.** The utterance asks about an
  objective in `coveredObjectiveIds`, and a **prior persona turn in the
  transcript states the answer**. Label `silence`. The learner has already been
  told; another reply repeats it.
- **R6 — Covered question, invisible answer.** The objective is marked covered
  but the transcript does not show the answer. Do **not** label `silence` on the
  strength of `coveredObjectiveIds` alone. Label `speak` with the owner, or fix
  the task before labelling. A state flag the learner cannot see is not evidence.
- **R7 — Thinking aloud, self-answer, side comment.** No eligible addressee.
  Label `silence`.
- **R8 — Named non-owner.** The learner names a persona who is not the owner.
  Label `speak` with the owner; the named persona is the distractor. The owner
  must be eligible, otherwise the task is invalid.
- **R9 — Mixed.** Label `mixed` only when both a persona reply and learner yield
  are genuinely acceptable. Do not use it to avoid deciding ownership.

## Closing moves

A closing move is a speech act with no request for information or action. Tests:

- Does the utterance ask for a fact, a decision or an action? If no, it is a
  closing move.
- Does removing the topic words leave a complete acknowledgement? If yes, it is
  a closing move.
- Would a persona replying add anything the learner did not already accept? If
  no, it is a closing move.

Examples: "Thanks, I'll make a note of that", "Understood", "Right", "Got it",
"Merci, je prends note", "D'accord", "Compris", "C'est noté".

## Visible coverage

`coveredObjectiveIds` is a bookkeeping flag. It records that an objective was
covered, not that the learner saw the answer. A `silence` label under R5 must
cite a transcript span that states the answer.

| Transcript                                                                                                                                     | Class                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Persona: "The budget is approved." Learner: "What is the latest on the budget?"                                                                | `silence` — the answer is visible                    |
| Persona: "We need to keep the budget review moving." Learner: "What is the latest on the budget?" with `coveredObjectiveIds: ["manager_goal"]` | `speak` — coverage is metadata, not a visible answer |
| Persona: "Notifications move to the next release." Learner: "So notifications are not shipping Friday?"                                        | `speak` — a confirmation request, not a repeat       |

## Family map

The M3c P3 taxonomy froze these families. P4 authors them; this guideline decides
their labels.

| Family                            | Class                | Evidence                                          |
| --------------------------------- | -------------------- | ------------------------------------------------- |
| `RT-S1` Named direct address      | `speak`              | Named owner objective                             |
| `RT-S2` Uncovered objective       | `speak`              | Objective keyword, not in `coveredObjectiveIds`   |
| `RT-S3` Correction                | `speak`              | Concrete error or misunderstanding prevented      |
| `RT-S4` Decision request          | `speak`              | Owner asked to decide or approve                  |
| `RT-Q1` Acknowledgement / closing | `silence`            | Closing move                                      |
| `RT-Q2` Covered question, visible | `silence`            | Prior transcript span states the answer           |
| `RT-Q3` Thinking aloud            | `silence`            | No addressee                                      |
| `RT-Q4` Side comment              | `silence`            | No eligible addressee                             |
| `RT-D1` Named non-owner           | `speak` to the owner | Owner eligible; named persona is the distractor   |
| Mixed                             | `mixed`              | Both a persona reply and learner yield acceptable |

## Worked examples

These are illustrative, not tasks.

| Learner turn                               | State                                          | Label                                          |
| ------------------------------------------ | ---------------------------------------------- | ---------------------------------------------- |
| "Katherine, can you confirm the budget?"   | `manager_goal` belongs to `manager`, uncovered | `speak` to `manager`                           |
| "What is the latest on the budget?"        | prior persona turn: "The budget is approved."  | `silence`                                      |
| "What is the latest on the budget?"        | only `coveredObjectiveIds: ["manager_goal"]`   | `speak` to `manager`                           |
| "Thanks, I'll make a note of that."        | no request                                     | `silence`                                      |
| "Merci, je prends note."                   | no request                                     | `silence`                                      |
| "Sam, what is the latest on the budget?"   | `manager` owns budget, `peer` does not         | `speak` to `manager`; `peer` is the distractor |
| "I think I should update the board first." | thinking aloud                                 | `silence`                                      |
| "Should we ship export on Friday?"         | `manager` owns the priority decision           | `speak` to `manager`                           |

## Prohibited labels

- `silence` for a closing move with a topic keyword and no visible answer.
- `silence` based only on `coveredObjectiveIds`, with no transcript span.
- `speak` for an acknowledgement.
- `speak` naming the persona the learner addressed when that persona is not the
  owner.
- `mixed` used as a fallback when ownership is unclear.

## Evidence and storage

- Put the ownership or visible-coverage evidence in the golden `note`: the
  objective id, the owner, or the transcript span.
- `labelSource` stays `agent` until a human double-label pass replaces it.
- A changed label set gets a new version, never an edit to `1.0.0`.

## Version boundary

`synthetic-routing/1.0.0` stays exactly as it is, including the labels the P3
taxonomy found ambiguous. This guideline applies to `1.1.0` and later. A task's
`annotationVersions.annotationGuideline` must name `m3a-routing-label-v2` when it
uses this rule.

## Conformance checklist

- [ ] Every `speak` label names an owner or cites a correction.
- [ ] Every closing move is `silence`.
- [ ] Every covered-question `silence` cites a transcript span that states the
      answer.
- [ ] No `silence` label rests on `coveredObjectiveIds` alone.
- [ ] Every named non-owner task names the owner, not the named persona.
- [ ] No `mixed` label lacks both a persona reply and learner yield.
- [ ] `1.0.0` is untouched.
