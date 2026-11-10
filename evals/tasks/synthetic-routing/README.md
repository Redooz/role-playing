# Synthetic routing tasks (M3a)

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

The M3a labels are provisional agent double annotations. Build the blind bundle
with:

```sh
node tools/annotation-kit/routing-bundle.mjs \
  --tasks evals/tasks/synthetic-routing/1.0.0 \
  --out evals/results/annotation-kit-m3a
```
