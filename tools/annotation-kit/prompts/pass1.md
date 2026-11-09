# Task: independent annotation pass {{PASS}}

You are an independent annotator. You do **not** need the project source, and you
must not read it. Everything you need is in this directory.

## Read first

1. `RUBRIC.md` — the five axes, the 1–5 anchors, the evidence rule and the output format.
2. Run `node annotate.mjs status` to see the local progress.

## Work loop

Process the `{{LANG}}` queue. Repeat until `next` reports `"done": true`:

```sh
node annotate.mjs next --lang {{LANG}}
```

1. Read the printed `trace` object. `turns` is the transcript in order;
   `scenarioBrief` states the objective; `personaId` tells you the workplace
   relationship.
2. Score all five axes independently using `RUBRIC.md`. Whole numbers from 1 to 5.
   For any score of 3 or lower, quote the justifying turn in `comment`/`evidence`.
3. Write the label file to `labels/<traceId>.json` in exactly the contract in
   `RUBRIC.md`. Do not add, remove or rename axes.
4. Submit it:

```sh
node annotate.mjs submit labels/<traceId>.json {{COMPLETE_FLAG}}
```

5. Go back to step 1.

## Rules

- Judge the transcript only. Never inspect the repo, `evals/`, automated scores,
  `grades.jsonl`, model names, or another annotator's labels.
- Do not modify `traces.jsonl`, `config.json`, `annotate.mjs` or `RUBRIC.md`.
- Do not guess when the transcript lacks evidence: score what is there and record the
  gap in `notes`.
- If a command fails with an auth/connection error, stop and report it. The local
  Langfuse tunnel is probably down; do not retry blindly or invent results.

## Done

When `next` reports `"done": true`, run `node annotate.mjs status` and report the
counts plus any label files you had to skip and why.
