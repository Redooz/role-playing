# Eval task and golden data

Directory contract for English/French eval data (M0 D5, architecture plan §4.4 and
§4.6). The **workflow is the deliverable**, not dataset size: seeds are synthetic
stubs so the validator, schemas, and CI gate exist before any real data does.

```text
evals/tasks/<dataset>/<version>/<lang>/**/*.json   task entries (input turns + metadata)
evals/golden/<lang>/<version>/**/*.json               human labels (human-based grading)
```

`<lang>` is `en` or `fr`. Every JSON file must be in one of those two shapes,
otherwise `validateTaskTree` reports `INVALID_LAYOUT`.

## Validation

Zod schemas live in `packages/eval-harness/src/tasks/schema.ts`; the walker
lives in `packages/eval-harness/src/tasks/validate.ts`. Run it in CI with:

```sh
npm run validate:tasks
```

The gate (G3) is **zero violations**. A violation has a file path (relative to
the repo root), a stable code, and a message; the validator returns them instead
of throwing. Library entry point: `validateTaskTree(rootDir)` in
`packages/eval-harness/src/tasks/validate.ts`, where `rootDir` is the repository
root (the directory that contains `evals/`).

Codes: `EVALS_DIR_MISSING`, `UNREADABLE_DIRECTORY`,
`UNREADABLE_FILE`, `INVALID_JSON`, `INVALID_LAYOUT`, `SCHEMA_VIOLATION`,
`MISSING_PROVENANCE`, `MISSING_CONSENT_SCOPE`, `MISSING_ANNOTATION_VERSIONS`,
`LANG_PATH_MISMATCH`, `LOCALE_PATH_MISMATCH`, `DUPLICATE_ID`, `SPLIT_LEAKAGE`,
`GOLDEN_AGREEMENT_MISSING`, `GOLDEN_TASK_MISSING`,
`GOLDEN_TASK_SPLIT_MISMATCH`, `GOLDEN_LOCALE_MISMATCH`,
`SESSION_REFERENCE_MISSING`, `SESSION_VERSION_MISMATCH`,
`SESSION_LOCALE_MISSING`, `SESSION_PERSONA_MISMATCH`, `SPEAKER_LABEL_INVALID`.

## Session tasks (M2)

`mode: "session"` tasks point at a registered persona and scenario instead of
storing persona turns:

```json
{
  "mode": "session",
  "locale": "en-GB",
  "content": { "turns": [] },
  "session": {
    "personaId": "manager",
    "personaVersion": "1.0.0",
    "scenarioId": "request-deadline-extension",
    "scenarioVersion": "1.0.0",
    "scriptedUserTurns": ["Could I have two more days?"]
  }
}
```

- `locale` is optional and defaults to the base language. It must be a canonical
  BCP 47 tag whose base language matches `lang`.
- A missing persona/scenario variant for the task locale is a validation error,
  never a fallback.
- `recordedPersonaTurns` is a canned-regression fixture only. A live run ignores
  it and the model generates the persona turns.
- A replay task (`mode` omitted or `"replay"`) keeps `content.turns`.

### Multi-persona session tasks (M3b)

`session.personaIds` is optional and additive. When present it lists the
eligible personas in driver order; the first entry must equal the opening
`personaId`. Every listed persona must resolve, match `personaVersion`, have a
locale variant, and belong to the scenario variant. The M3b data lives in
`synthetic-multi-persona-session/m3b-v1`, separate from the M2
`synthetic-workplace-session` dataset, so the M2 canned regression still selects
only its original six tasks.

A golden entry for a multi-persona session uses `speakerLabels` instead of the
routing labels: one entry per scripted user turn, with an acceptable persona set
(or learner yield) and `labelSource`. The validator requires every user turn,
rejects unknown personas, and refuses `stable` while the labels are agent-only.
The D5 labels are `draft`; their two-pass agreement was 0.75 per language, below
the pre-registered 0.80, so they are not ground truth.

## Provenance and consent

Every task carries structured `provenance` and a non-empty `consentScope`.
Synthetic data is the default in M0 (resolved decision O4):

```json
"provenance": { "source": "synthetic" },
"consentScope": "synthetic-no-consent-required"
```

- `source: "synthetic"` means the task text was authored by us. All seed text is
  original synthetic content; no real conversation or personal data is committed.
- `source: "recorded"` is reserved for the consented collection workflow (§4.6.1).
  Such entries must state a `consentScope` that covers storage, annotation, and
  evaluation use, plus `collectedAt`, and may only be added after that workflow
  exists. Do not relabel synthetic text as recorded.
- `annotationVersions` names the rubric and annotation-guideline versions used to
  label the entry, so a label can always be traced to the instructions behind it.

## Calibration/holdout split rule

The validator rejects any `speakerId` that appears in **both** `calibration` and
`holdout`. Splitting by utterance instead of speaker inflates scores because the
same voice, accent, and speaking habits leak into both sides (§4.6.5).

Scope: the rule is evaluated per `<dataset>/<version>/<lang>`. A speaker id may
appear in another dataset, another version, or the other language; only within
one scope is it leakage. Duplicate ids are scoped the same way for tasks and
by `<lang>/<version>` for golden entries.

Holdouts are frozen during development (§4.6.6). Changing a holdout entry
requires a new dataset version and fresh independent validation; editing `v1`
in place invalidates results that referenced it.

## Golden entries

Golden entries are the human-based grader: they carry routing labels (or, for a
multi-persona session, `speakerLabels`), 1–5 per-dimension scores, evidence
spans, blind pairwise preferences, and an optional `annotatorAgreement` block. A
golden entry's `taskId`, when present, must resolve to a task in the same
language and version, and its `split` must match that task's split. A golden
entry may only use `status: "stable"` when agreement was measured with at least
two distinct annotators and a stated metric/value (§4.4.4). The seeded English
and French entries are `draft` on purpose: a single annotation pass is not
agreement, so they are not ground truth yet.

A session task runs several rounds, so `taskId` alone does not identify the
transcript being labelled. A labelled trial may add `runId`, `round` and
`trialId`; supply all three together. `trialId` must use the harness form
`${round}:${lang}:${taskId}` (for example
`2:en:en-b1-deadline-manager-101`). Entries without a trial reference remain
valid for task-level labels.

## M2 labelling plan

The accepted Gemma runs are the candidate `m2-persona-scenarios-lk` and the
generic baseline `m2-persona-baseline-lk`. Label the transcripts, not the
`grades.jsonl` scores.

**Sample-size check.** The base run has 6 tasks × 5 rounds = 30 trials, i.e.
**15 per language**. The M2 plan asks for 30 labels per base language. Resolve
this before labelling:

- label both baseline and candidate: 15 + 15 = 30 per language, no new model
  calls (recommended); or
- run 10 rounds of the candidate: 3 tasks × 10 = 30 per language; or
- add a second scenario per language: 6 tasks × 5 rounds = 30 per language.

The locale probe has 3 tasks × 3 rounds = **9 per locale**, but the plan asks for 10. Label baseline plus variants (18 per locale), or run a fourth round.

Use `m2-annotation-guideline-v1`. Each entry records `runId`, `round` and
`trialId`; keep entries `draft` until the double-labelled subset has a measured
agreement block.

## Deletion propagation (§4.6.9)

No production data exists in M0, but the hooks are fixed now so deleting a
consented recording later is a documented procedure rather than an incident:

1. Delete `evals/tasks/<dataset>/<version>/<lang>/<id>.json`.
2. Delete or `taskId`-detach golden entries that point at that id.
3. Invalidate cached Jev scores whose canonical payload contains the transcript
   (`evals/.cache/` is content-addressed, so the affected entries are the ones
   derived from that task; never reuse a stale score across a changed payload,
   §4.3).
4. Record the deletion in the dataset version notes and bump the dataset version
   if the removed entry was part of a frozen holdout. Baseline and result files
   that reference the removed task keep their run id but must not be reused
   for a new comparison.
5. If the deletion request came from a participant, remove the speaker id from
   split bookkeeping as well, so the id cannot silently reappear.
