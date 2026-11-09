# Annotation rubric — M2 persona trials (v1)

You are the annotator. Score **one whole trial** at a time: the greeting turn, every
learner turn and every persona reply in that transcript. Do not score individual
turns in isolation; each axis describes the whole trial.

Do not look at automated scores, another annotator's labels, model names, or the
project source. Judge the transcript in front of you.

## Scale

| Score | Meaning                                                                  |
| ----- | ------------------------------------------------------------------------ |
| 5     | Fully meets the criterion. No issue worth mentioning.                    |
| 4     | Meets the criterion with a minor issue that does not change the outcome. |
| 3     | Mixed. The issue is noticeable and a reviewer could reasonably disagree. |
| 2     | Clearly fails the criterion.                                             |
| 1     | Severe failure, or the behaviour makes the scenario unusable.            |

Use whole numbers only. Score each axis independently.

## Axes

### `persona.consistency`

Do all persona replies stay in the same professional role and voice?

- 5: Stable role, tone and boundaries across every turn.
- 3: One turn drifts into a generic assistant or changes voice, but the role is recoverable.
- 1: The persona is absent, changes identity, or behaves like a generic chatbot.

### `language.quality`

Are the persona replies in correct target-language English/French, with appropriate grammar and vocabulary?

- 5: Fluent, natural, no distracting error.
- 3: One noticeable grammar or vocabulary error; meaning is still clear.
- 1: Serious errors make the reply hard to understand, or the wrong language is used.

### `register.fit`

Is the register appropriate for the workplace relationship in the scenario? Use `personaId`: a manager is direct, a peer is informal, a client is formal and diplomatic.

- 5: Matches the expected formality and diplomacy.
- 3: Slightly too casual or too formal; still plausible.
- 1: Impolite, hostile, or wildly inappropriate for the relationship.

### `response.clarity`

Are the persona replies clear and concise rather than rambling?

- 5: Understandable and reasonably short.
- 3: Repetitive, indirect, or long-winded, but the point is recoverable.
- 1: Confusing or so long that the learner cannot act on it.

### `objective.completion`

Do the persona replies help the learner complete the scenario objective? The `scenarioBrief` field states the objective.

- 5: A realistic opening and responsive turns that let the objective be met.
- 3: Partly helps, but a turn blocks or delays the objective.
- 1: Blocks the objective, ignores the learner, or invents facts that make it impossible.

## Evidence

For every score of **1–3**, quote the turn that justifies it: include `turn` and a short
verbatim `text` fragment in `evidence`, or put the quoted turn in `comment`.
For a 4–5, evidence is optional unless the score depends on a specific turn.

If the transcript lacks the evidence needed for an axis, say so in `notes` and do not
guess. That is a transcript finding, not a model failure.

## Binary mapping (for reporting only)

`4`–`5` maps to **yes**; `1`–`3` maps to **no**. Do not change scores to fit this mapping.

## Output contract

Write one JSON file per trial to `labels/<traceId>.json`:

```json
{
  "traceId": "<copy exactly from the trace>",
  "scores": {
    "persona.consistency": { "value": 5, "comment": null },
    "language.quality": { "value": 4, "comment": "One article error in turn 3." },
    "register.fit": { "value": 5, "comment": null },
    "response.clarity": {
      "value": 2,
      "comment": "Rambles for four sentences; the point only lands at the end.",
      "evidence": [{ "turn": 4, "text": "…" }]
    },
    "objective.completion": { "value": 5, "comment": null }
  },
  "notes": "Optional: any ambiguity or missing evidence."
}
```

Every one of the five axes is required. The submit tool enforces the scale, the
evidence rule, and the exact axes; it also stamps the submission so a retry updates
the same scores instead of duplicating them.
