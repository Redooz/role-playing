# Synthetic routing tasks (M3a, M3c)

## `1.0.0` — M3a

120 offline routing decision points: 60 English and 60 French.

- 30 calibration and 30 holdout tasks per language.
- Five scenario families per split, six decision shapes per family.
- Decision shapes: direct manager, direct peer, direct client, manager objective,
  no contribution, and either two-speaker or already-covered context.
- Each task uses the three registered personas and a synthetic transcript.
- `speakerId` is scoped per language and split; calibration and holdout do not
  share a speaker id.

The policy-visible state lives only in `routing.context`. Acceptable outcomes are
not stored on tasks: they live in golden entries and annotation bundles, so a
policy cannot read the answer.

## `1.1.0` — M3c P4

160 offline routing decision points: 80 English and 80 French.

- 40 calibration and 40 holdout tasks per language.
- Every slice carries 22 speak-required, 14 silence-required and 4 mixed
  decisions. The ten frozen families all occur.
- Holdout carries six named non-owner distractors, calibration four.
- Five workplace topics; the regular families are topic templates, while the
  state negatives (named non-owner, closing move with a name, covered question
  with a visible answer, self-directed reasoning with a keyword) are written
  out in full.
- `composition.json` is the pre-registered contract. `npm run validate:tasks`
  compares it with the tree; `scripts/generate-routing-1.1.0.spec.ts` proves the
  committed files equal the generator output.

Authoring is deterministic:

```sh
node scripts/generate-routing-1.1.0.mjs
```

Labels use `m3a-routing-label-v2` and `annotationVersions.annotationGuideline`
names it. They are agent labels: provisional, not human ground truth.

`1.0.0` stays frozen on `m3a-routing-label-v1`. The two versions are not
comparable.

## Blind annotation bundle

Build one bundle from a version directory:

```sh
node tools/annotation-kit/routing-bundle.mjs \
  --tasks evals/tasks/synthetic-routing/1.1.0 \
  --out evals/results/annotation-kit-m3c \
  --guideline m3a-routing-label-v2
```

The bundle contains only an opaque `caseId`, the learner-visible transcript,
personas, objectives and covered ids. The operator manifest next to it (not in
the bundle) adds the real task id, split and expected class. Keep it away from
annotators, and give a separate copy to each pass.

Compare the two passes with per-language and per-class agreement:

```sh
node tools/annotation-kit/routing-analyze-agreement.mjs \
  --a /path/to/pass-a/labels --b /path/to/pass-b/labels \
  --classes /path/to/bundle-operator/manifest.json \
  --min 0.8 --min-per-class 0.8
```
