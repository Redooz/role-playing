# Synthetic multi-persona session tasks (M3b, M3c)

## `m3b-v1` — M3b

12 session tasks per base language, all on `standup-scope-change`.

- 6 calibration and 6 holdout tasks per language, split across the base locale
  and its regional variant.
- Four scripted learner turns per task. Every labelled turn requires a speaker,
  so the suite is one-sided and is frozen.
- Goldens live in `evals/golden/<lang>/m3b-v1/`; the D5 two-pass agreement was
  0.75 per language, below the pre-registered 0.80.

`m3b-v1` is grandfathered on the composition rule and stays unchanged.

## `m3b-v2` — M3c P5

22 session tasks per base language, two two-persona scenarios.

| Split       | Tasks | Speak | Silence | Mixed | Total turns |
| ----------- | ----- | ----- | ------- | ----- | ----------- |
| Calibration | 10    | 28    | 10      | 2     | 40          |
| Holdout     | 12    | 34    | 12      | 2     | 48          |

- Scenarios: `standup-scope-change` and `post-demo-handover`.
- Four scripted learner turns per task, 88 labels per language.
- Holdout carries 8 named-non-owner distractors, calibration 4.
- All twelve frozen families occur in every slice (`minFamilies: 12`); the
  largest family has 8 labels (`maxPerFamily: 8`).
- `composition.json` is the pre-registered contract. `npm run validate:tasks`
  compares it with the tree; `scripts/generate-m3b-v2.spec.ts` proves the
  committed files equal the generator output.

Authoring is deterministic:

```sh
node scripts/generate-m3b-v2.mjs
```

Labels use `m3b-speaker-label-guideline-v1`; each task names it in
`annotationVersions.annotationGuideline`. They are agent labels: provisional, not
human ground truth.

## Blind annotation bundle

One case per learner turn:

```sh
node tools/annotation-kit/speaker-bundle.mjs \
  --tasks evals/tasks/synthetic-multi-persona-session/m3b-v2 \
  --out /tmp/m3c-p5-bundle \
  --guideline m3b-speaker-label-guideline-v1
```

The bundle carries the scenario facts, objectives, personas and the learner
turns up to the current turn. It never carries the task id, split or authored
label. The operator manifest next to it adds the real task, turn and expected
class; keep it away from annotators.

Compare two passes with per-language and per-class agreement:

```sh
node tools/annotation-kit/routing-analyze-agreement.mjs \
  --a /path/to/pass-a/labels --b /path/to/pass-b/labels \
  --classes /path/to/bundle-operator/manifest.json \
  --min 0.8 --min-per-class 0.8
```

The agreement helper is shared with routing because a speaker label has the same
`acceptablePersonaIds` and `allowUserYield` fields.
