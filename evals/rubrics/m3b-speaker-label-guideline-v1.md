# M3b speaker-label guideline v1

Version: `m3b-speaker-label-guideline-v1`
Applies to: no dataset. It is superseded by `m3b-speaker-label-guideline-v2` for
`m3b-v2` and later; v1 is kept for history.
Frozen: `m3b-v1` never uses this guideline and is never edited.

This is the missing rule the M3c P3 taxonomy identified. It defines **who owns a
learner turn**, so a speaker label is decided by the scenario rather than by an
annotator's sense that "someone should say something". Agent labels remain
triage; only blind human double-labelling can make a semantic gate `stable`.

This guideline labels **speakers**. It is not the interjection rubric
(`m3b-turn-taking-rubric-v1`), which asks whether a persona should interrupt an
active reply. The two answer different questions and are not interchangeable.

## Unit

One `speakerLabels` entry per scripted learner turn, keyed by `turnIndex`
(`0` is the first learner turn after the greeting). A label describes the turn,
not a persona; the acceptable personas are a field on that one label.

## Classes

| Class     | `acceptablePersonaIds` | `allowUserYield` | Meaning                                                   |
| --------- | ---------------------- | ---------------- | --------------------------------------------------------- |
| `speak`   | non-empty              | `false`          | At least one eligible persona must produce the next turn. |
| `silence` | empty                  | `true`           | The learner continues alone; no persona speaks.           |
| `mixed`   | non-empty              | `true`           | Either a persona reply or learner yield is acceptable.    |

A label that accepts neither a persona nor learner yield is invalid. `mixed` is
counted and reported but never folded into either class rate.

## The ownership test

Apply the steps in order. Do not start from the utterance alone.

1. **Identify the move.** Is the learner addressing a persona, handing off to a
   named colleague, asking a collective question, asking who owns something,
   asking for a next step, closing the turn, thinking aloud, answering their own
   question, or making a side comment?
2. **Find the owner in the scenario.** An owner exists only when one of these is
   true:
   - an objective has the persona in `personaIds` and its `keywords` cover the
     topic; or
   - a scenario fact names the persona **and** the responsibility in one
     sentence (for example, "Sam owns the notification documentation").
3. **A fact is not an owner by itself.** "The client demo is on Wednesday" is
   context. It does not make the manager the owner of client communication.
   "The release is on Friday" does not make anyone the owner of scheduling.
4. **Apply the class.**
   - Owner exists and the learner addresses that owner, by name or collectively:
     `speak` with the owner in `acceptablePersonaIds`.
   - No owner, or the turn is a closing/self-directed move: `silence`.
   - A persona reply and learner yield are both genuinely acceptable: `mixed`.
5. **Record the evidence.** Put the scenario field that establishes ownership in
   the golden `note`, for example
   `owner: objectives[state-next-step].personaIds=[manager]` or
   `owner: facts[3] "Sam owns the notification documentation"`.

If step 2 cannot name an owner, the label is `silence`. Do not label `speak`
because a question was asked, because a topic appears in the scenario, or
because a persona "could" answer.

## Rules

- **R1 — Explicit ownership.** A `speak` label must name the owner in
  `acceptablePersonaIds` and cite the scenario field in `note`.
- **R2 — Collective requests are owned or silent.** "Can someone summarise…"
  is `speak` only when exactly one persona (or a declared pair) owns the topic.
  "Someone" is not an owner.
- **R3 — Learner-owned next steps are silent.** When the scenario makes the
  learner responsible for stating the next step, a persona does not answer
  "what should I do next?" or "who will document this?" unless the scenario also
  assigns that specific responsibility to a persona.
- **R4 — A named non-owner is a distractor.** If the learner names a persona who
  is not the owner, `acceptablePersonaIds` names the owner, not the persona the
  learner named. The named persona is the distractor. The owner must be eligible;
  otherwise the task is invalid.
- **R5 — Closing moves are silent.** "Thanks, noted", "understood", "right",
  "merci, je prends note" close the turn. A name inside a closing move does not
  make it `speak`.
- **R6 — Thinking aloud, self-answer and side comments are silent.** The learner
  is not addressing an eligible persona, even when the words mention a topic.
- **R7 — Mixed is not a default.** Use it only when a persona reply and learner
  yield are both genuinely acceptable. Do not use it to avoid deciding ownership.
- **R8 — Name the owner, not the topic.** `acceptablePersonaIds` is the set of
  personas who may produce the next turn. It is not the set of personas who know
  about the topic.

## Family map

The M3c P3 taxonomy froze these families. P5 authors them; this guideline decides
their labels.

| Family                               | Class                | Owner evidence                                    |
| ------------------------------------ | -------------------- | ------------------------------------------------- |
| `TT-S1` Named direct address         | `speak`              | Objective with `personaIds` and keywords          |
| `TT-S2` Named handoff                | `speak`              | Objective with `personaIds` and keywords          |
| `TT-S3` Owned open floor             | `speak`              | Explicit owner fact                               |
| `TT-S4` Owned ownership question     | `speak`              | Explicit owner fact                               |
| `TT-S5` Owned external communication | `speak`              | Explicit owner fact                               |
| `TT-S6` Owned next-step guidance     | `speak`              | Explicit owner fact                               |
| `TT-Q1` Acknowledgement / closing    | `silence`            | Closing move                                      |
| `TT-Q2` Thinking aloud               | `silence`            | No addressee                                      |
| `TT-Q3` Self-answer                  | `silence`            | Learner continues alone                           |
| `TT-Q4` Side comment                 | `silence`            | No eligible addressee                             |
| `TT-D1` Named non-owner              | `speak` to the owner | Owner fact; named persona is the distractor       |
| Mixed                                | `mixed`              | Both a persona reply and learner yield acceptable |

## Worked examples

These are illustrative, not tasks. Each shows the decision the rule forces.

| Learner turn                                | Scenario state                                                              | Label                |
| ------------------------------------------- | --------------------------------------------------------------------------- | -------------------- |
| "Katherine, what ships instead?"            | `agree-priority` has `personaIds: ["manager"]`                              | `speak` to `manager` |
| "Can someone summarise the scope change?"   | no persona owns the summary                                                 | `silence`            |
| "Can someone summarise the scope change?"   | fact: "Katherine owns the scope summary"                                    | `speak` to `manager` |
| "Who will document the partial work?"       | `state-next-step` is the learner's objective; no persona owns documentation | `silence`            |
| "Who will document the partial work?"       | fact: "Sam owns the notification documentation"                             | `speak` to `peer`    |
| "How do we keep the client informed?"       | fact: "The client demo is on Wednesday" only                                | `silence`            |
| "How do we keep the client informed?"       | fact: "Katherine owns client communication"                                 | `speak` to `manager` |
| "What should I do before the demo?"         | learner owns `state-next-step`                                              | `silence`            |
| "Sam, how far along are the notifications?" | `assess-impact` has `personaIds: ["peer"]`                                  | `speak` to `peer`    |
| "Thanks, noted."                            | no request                                                                  | `silence`            |
| "Sam, thanks, noted."                       | closing move with a name                                                    | `silence`            |

## Prohibited labels

- `speak` with no owner cited in the scenario.
- `speak` because the utterance contains a question mark or a scenario topic.
- `silence` for a direct address to the declared owner.
- `mixed` used as a fallback when ownership is unclear.
- A label whose `acceptablePersonaIds` names the persona the learner addressed
  rather than the owner, when those differ.

## Evidence and storage

- Put the ownership evidence in the golden `note`; keep it short and
  machine-searchable: `owner: <field>[<id>].personaIds=[...]`.
- `labelSource` stays `agent` until a human double-label pass replaces it.
- A changed label set gets a new version, never an edit to `m3b-v1`.

## Version boundary

`m3b-v1` and its goldens stay exactly as they are, including the labels the P3
taxonomy found ambiguous. This guideline applies to `m3b-v2` and later. A task's
`annotationVersions` must name `m3b-speaker-label-guideline-v2` when it uses this
rule; v1 is kept for history and no task pins it.

## Conformance checklist

- [ ] Every `speak` label cites an owner field in `note`.
- [ ] Every `silence` label has a reason: no owner, closing move, thinking
      aloud, self-answer or side comment.
- [ ] Every collective request either names an owner or is `silence`.
- [ ] Every named non-owner task names the owner, not the named persona.
- [ ] No `mixed` label lacks both a persona reply and learner yield.
- [ ] `m3b-v1` is untouched.
