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
`LANG_PATH_MISMATCH`, `DUPLICATE_ID`, `SPLIT_LEAKAGE`,
`GOLDEN_AGREEMENT_MISSING`.

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

Golden entries are the human-based grader: they carry routing labels, 1–5 per-dimension scores, evidence spans,
blind pairwise preferences, and an optional `annotatorAgreement` block. A golden
entry may only use `status: "stable"` when agreement was measured with at least
two distinct annotators and a stated metric/value (§4.4.4). The seeded English
and French entries are `draft` on purpose: a single annotation pass is not
agreement, so they are not ground truth yet.

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
