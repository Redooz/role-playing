# Annotation kit

Reusable, context-free annotation agents for Langfuse queues. An annotator gets a
folder containing transcripts, a rubric, and one CLI. It never needs the repository,
eval scores, grades, or another annotator's labels.

Use it for double annotation: build one bundle, then give **a separate copy of the
folder to each pass**, with its own `labels/` directory and its own pass id.

## 1. Build a bundle (operator)

`build-bundle.mjs` reads run artifacts (`result.json`, `langfuse.json`,
`transcripts/`) and the queue items, and writes `traces.jsonl` + `config.json` +
an operator-only trace→run manifest.

```sh
node tools/annotation-kit/build-bundle.mjs \
  --repo . --out evals/results/annotation-kit-m3 \
  --run evals/results/m3-run-a --run evals/results/m3-run-b \
  --queue en=<queue-id> --queue fr=<queue-id> \
  --axis persona.consistency=<config-id> \
  --axis language.quality=<config-id> \
  --axis register.fit=<config-id> \
  --axis response.clarity=<config-id> \
  --axis objective.completion=<config-id>
```

The annotator bundle contains no scores, model names or candidate/baseline labels.
The trace→run map goes to `<out>-operator/manifest.json`; keep it away from annotators.

## 2. Run a pass

Copy the bundle to a fresh directory (one per pass), then:

```sh
cd /path/to/pass-a
node annotate.mjs status
node annotate.mjs next --lang en
node annotate.mjs submit labels/<traceId>.json            # leave PENDING for review
node annotate.mjs submit labels/<traceId>.json --complete # mark the item done
node annotate.mjs complete-all                            # mark every item done
```

Pass ids keep two annotators from overwriting each other: the pass id is part of the
score ID and is stored in `metadata.pass`. Set `defaultPass` in `config.json` for a
copy, or pass `--pass <id>` explicitly. Use a new pass id when the rubric changes.

Useful options:

| Option                     | Meaning                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `--labels <dir>`           | Label directory (default `labels`).                          |
| `--pass <id>`              | Annotator pass id (default `config.defaultPass`, else `p1`). |
| `--complete`               | Also PATCH the queue item to `COMPLETED`.                    |
| `--dry-run`                | Validate and print the score payload; write nothing.         |
| `--allow-missing-evidence` | Permit 1–3 without a quote (not recommended).                |

## 3. Measure agreement

```sh
node tools/annotation-kit/analyze-agreement.mjs \
  --a /path/to/pass-a/labels --b /path/to/pass-b/labels
```

Reports, per axis and overall: n, exact agreement, quadratic weighted kappa for the
1–5 scores, and Cohen's kappa for the binary mapping (`4–5 = yes`, `1–3 = no`). This
script is deterministic; it does not call a model.

## 4. Launch a context-free agent

Start a new agent whose working directory is the pass copy and give it `prompts/pass1.md`
or `prompts/pass2.md`, with `{{LANG}}` filled in. Do not give it any other context.
For a second pass, use a separate folder and `prompts/pass2.md`; the prompt forbids
reading any other labels directory.

Set `ANNOTATOR_MODEL` when submitting if you want the model recorded in score
metadata. Otherwise it is `unspecified`.

## Routing labels (M3a)

Routing tasks do not use Langfuse queues. Build a local bundle from the committed
routing tasks:

```sh
node tools/annotation-kit/routing-bundle.mjs \
  --tasks evals/tasks/synthetic-routing/1.1.0 \
  --out evals/results/annotation-kit-m3c \
  --guideline m3a-routing-label-v3
```

`--guideline` and `--rubric` default to the `1.0.0` versions; name the new
guideline when the tasks pin it. The version defaults to the task directory
name.

`cases.jsonl` contains only an opaque `caseId`, the learner-visible transcript,
personas, objectives and covered ids. It excludes the real task id, split, speaker
id, labels, run ids, arms and scores. The opaque-to-real-task mapping is written
operator-only to `<out>-operator/manifest.json`; keep it away from annotators.
Give a separate copy to each pass.

An annotator writes one JSON file per case:

```json
{
  "caseId": "case-0123456789abcdef",
  "lang": "en",
  "intent": "answer-manager",
  "acceptablePersonaIds": ["manager"],
  "allowUserYield": false
}
```

Compare the two passes:

```sh
node tools/annotation-kit/routing-analyze-agreement.mjs \
  --a /path/to/pass-a/labels --b /path/to/pass-b/labels \
  --classes /path/to/bundle-operator/manifest.json \
  --min 0.8 --min-per-class 0.8
```

Without `--classes` the report gives exact accepted-outcome agreement overall
and per language. With it, the report adds agreement per class and per
language × class, plus two directional counts: `aSilenceBSpoke` (pass A said
silence while pass B said speak) and `aSpokeBSilence`. A missing case exits 2.
Any language, class or cell below its bar exits 3. This is agent/provisional
annotation unless the labels come from blind human double-labelling.

## Speaker labels (M3b)

Session tasks do not use Langfuse queues either. Build a local bundle with one
case per learner turn:

```sh
node tools/annotation-kit/speaker-bundle.mjs \
  --tasks evals/tasks/synthetic-multi-persona-session/m3b-v2 \
  --out evals/results/annotation-kit-m3c-speakers \
  --guideline m3b-speaker-label-guideline-v1
```

`cases.jsonl` contains an opaque `caseId`, the locale, the scenario state
(setting, facts, objectives), the eligible personas and the learner turns up to
the turn being labelled. It excludes the task id, split, speaker id, authored
labels, run ids, arms and scores. The opaque-to-real mapping, with the expected
class, is written operator-only to `<out>-operator/manifest.json`.

An annotator writes one JSON file per case:

```json
{
  "caseId": "case-0123456789abcdef",
  "lang": "en",
  "intent": "answer-manager",
  "acceptablePersonaIds": ["manager"],
  "allowUserYield": false
}
```

Compare the passes with `routing-analyze-agreement.mjs` and `--classes`; a
speaker label uses the same fields as a routing label.

## The human-label rule

An LLM pass (the M2 pass used OpenCode) is not a human and is not a
`system-one-model` grader. Use these labels for prefill, triage and provisional
agreement. Do not call them human ground truth or use them to claim human–Jev
agreement. The project guideline requires blind human double-labelling before an
entry becomes `stable`.
