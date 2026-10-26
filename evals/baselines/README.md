# Baselines

Committed, accepted eval results. One file per evaluation suite:
`evals/baselines/<suite>.json`.

A baseline is not "the best number we ever saw". It is the result of a
pre-registered run that passed its own manifest: target improved, guardrails
did not regress, invariants held, and the decision was written to
`evals/decisions.md`. Each file carries the run ID, manifest hash, grader,
rubric, task and code versions, the target metric, guardrails and verdict.

`evals/results/` is git-ignored (except the curated `index.md`); only accepted
results are promoted here.

To promote a run, copy its `evals/results/<runId>/result.json` over the suite
file and run `npx prettier --write` on it (CI checks formatting). The recorded
`codeSha` is the commit that produced the run: regenerate the baseline after
the commit that changes eval behaviour or the harness, not before it.

A baseline's `runId` is the manifest's suite id, not a unique run id, so two
runs write the same directory name. The harness refuses to overwrite an existing
results directory; pass `--results-root` to keep them apart.

## M0 suites

| Suite                 | Gate | Status                             |
| --------------------- | ---- | ---------------------------------- |
| `m0-canned-replay`    | G1   | accepted (`m0-canned-replay.json`) |
| `m0-harness-overhead` | G5   | pending first accepted run         |

`m0-canned-replay.json` is a full `RunResult` artifact, exactly what
`tools/eval-harness-cli/src/cli.ts run` writes to `evals/results/<runId>/result.json`.
`compare --baseline evals/baselines/m0-canned-replay.json --run <dir>` reads it
directly, so a promoted baseline needs no reshaping. The transcript files it lists
stay with the (git-ignored) run directory; only the artifact and hashes are
committed.

The Jev canary (G4) is a canary, not a baseline: it proves the system-1-model
grader integration and does not gate behaviour, because no behaviour exists at
M0.
