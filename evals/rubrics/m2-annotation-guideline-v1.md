# M2 annotation guideline v1

Version: `m2-annotation-guideline-v1`
Rubric: `m2-persona-rubric-v1`
Applies to: `en`, `fr`, and the `en-GB`/`fr-CA` locale probe.

This is the human reference for the semantic axes. Label the transcript, not the
model. Do not look at Jev scores, `grades.jsonl`, or another annotator's labels
until your own pass is complete.

## Unit of annotation

One label set describes **one trial**: the greeting turn, every scripted learner
turn, and every persona reply in one transcript. Do not score individual turns
in isolation; an axis describes the whole trial.

Each trial is identified by `runId`, `round`, `taskId` and the harness
`trialId` (`${round}:${lang}:${taskId}`). Record all four on the golden entry.

## Axes and 1–5 anchors

Score each axis independently. Use the anchors below; do not invent a sixth
axis.

| Score | Meaning                                                                  |
| ----- | ------------------------------------------------------------------------ |
| 5     | Fully meets the criterion. No issue worth mentioning.                    |
| 4     | Meets the criterion with a minor issue that does not change the outcome. |
| 3     | Mixed. The issue is noticeable and a reviewer could reasonably disagree. |
| 2     | Clearly fails the criterion.                                             |
| 1     | Severe failure, or the behaviour makes the scenario unusable.            |

### `persona.consistency`

Do all persona replies stay in the same professional role and voice?

- 5: Stable role, tone and boundaries across every turn.
- 3: One turn drifts into a generic assistant or changes voice, but the role is
  recoverable.
- 1: The persona is absent, changes identity, or behaves like a generic chatbot.

### `language.quality`

Are the persona replies in correct target-language English/French with
appropriate grammar and vocabulary?

- 5: Fluent, natural, no distracting error.
- 3: One noticeable grammar or vocabulary error; meaning is still clear.
- 1: Serious errors make the reply hard to understand, or the wrong language is
  used.

### `register.fit`

Is the register appropriate for the workplace relationship in the scenario?

- 5: Matches the expected formality and diplomacy.
- 3: Slightly too casual or too formal; still plausible.
- 1: Impolite, hostile, or wildly inappropriate for the relationship.

### `response.clarity`

Are the persona replies clear and concise rather than rambling?

- 5: Understandable and reasonably short.
- 3: Repetitive, indirect, or long-winded, but the point is recoverable.
- 1: Confusing or so long that the learner cannot act on it.

### `objective.completion`

Do the persona replies help the learner complete the scenario objective?

- 5: A realistic opening and responsive turns that let the objective be met.
- 3: Partly helps, but a turn blocks or delays the objective.
- 1: Blocks the objective, ignores the learner, or invents facts that make it
  impossible.

### `locale.fit` (locale probe only)

Do the persona replies use the spelling, vocabulary and workplace norms of the
stated locale (`en-GB` or `fr-CA`)?

- 5: Consistently matches the stated locale.
- 3: Mostly matches, with one word or spelling from another variant.
- 1: Uses another locale's spelling, vocabulary or workplace norms.

## Binary mapping for Jev agreement

Jev answers a yes/no question per axis. Map the human score to the same binary
before comparing:

- **yes**: score `4` or `5`
- **no**: score `1`, `2` or `3`

Pre-register this mapping. Do not change it after seeing Jev's probabilities.

Use the 1–5 scores for human–human agreement and the binary mapping for
human–Jev agreement. Report both per axis and per language.

## Evidence

For every score of 1–3, quote the turn that justifies it in `evidenceSpans`:
`turnIndex` plus a short `textRef`. For a 4–5, evidence is optional unless the
score depends on a specific turn.

If the transcript itself lacks the evidence needed for an axis, say so in the
entry notes and do not guess. That is a rubric or transcript finding, not a
model failure.

## Double labelling

- Primary annotator per base language.
- A second annotator double-labels a **pre-registered** subset: at least 10
  trials per base language.
- The locale probe gets its own native reviewer: at least 10 trials per locale,
  with at least 4 double-labelled per locale.
- If the second annotator is unavailable, the semantic axes stay **provisional**.
  Do not treat a single-annotator pass as ground truth.

Annotators label independently and blind. Do not discuss individual trials
until both passes are stored.

## Storage

Create one golden entry per labelled trial under `evals/golden/<lang>/v1/`.

Required fields:

- `id`: unique, for example `golden-en-v1-lk-r0-en-b1-deadline-manager-101`
- `lang`, `locale` (for locale entries), `split` (must match the task)
- `taskId`, `runId`, `round`, `trialId`
- `routingLabels.expectedPersonaId`: use the current ids `manager`, `peer` or
  `client`
- `dimensionScores`: one entry per axis, with `score` and `rationale`
- `evidenceSpans`
- `pairwisePreferences`: `[]` for this pass
- `status`: `draft` until agreement is measured
- `notes`: the run id, label-set name and any ambiguity

Run `npm run validate:tasks` after every batch. Zero violations is the gate.

## Agreement

- Human–human agreement is the ceiling. Report it per axis and per language.
- Binary axes: Cohen's kappa and percent agreement.
- Ordinal 1–5 scores: quadratic weighted kappa or ICC(2,1); name the metric and
  value in `annotatorAgreement`.
- Human–Jev agreement: use the pre-registered binary mapping; report per axis
  and per language.
- Pre-register the acceptable divergence before labelling, including separate
  tolerances for a false failure and a missed failure.
- Only mark an entry `status: "stable"` after agreement is measured with at
  least two distinct annotators.

## What not to do

- Do not tune the Jev 0.50 threshold on the same labels used to report
  agreement. Threshold tuning needs a calibration/holdout split.
- Do not relabel a task as `recorded`; M2 data is synthetic.
- Do not use machine translation for the `en-GB` or `fr-CA` review.
- Do not change the rubric wording after labels exist without a new rubric
  version and a fresh agreement pass.
