# Task and transcript migrations

Required when the shared event/transcript schema takes a **breaking** change (a major
bump), per the versioning policy in `packages/session-core/src/version.ts` and
M0 plan D2.

Additive changes (new optional fields, new event kinds, widened enums) only bump
the minor version and need no entry here. A breaking change is not complete
until this file says how stored tasks and baselines move to the new major
version.

## Format

One section per major version, newest first:

```md
## 2.0.0 — YYYY-MM-DD

- **Breaking:** what changed.
- **Tasks:** how `evals/tasks/**` are migrated (script, manual edit, or
  "regenerated from synthetic seeds").
- **Golden/baselines:** whether existing golden entries and committed baselines
  stay valid, or must be re-run and re-promoted.
- **Transcript replay:** how old `evals/results/**` transcripts are read, if at all.
```

## History

### Eval artifact migration — 2026-10-25 (3.0.0)

The eval vocabulary changed: eval fixture → **task**, repetition → **round** for a
pass over the suite and **trial** for one attempt at one task, scorer → **grader**,
trace → **transcript**. This did not change the shared event/transcript schema,
which stays at `1.0.0`. It did change the eval artifacts to `3.0.0`:

- manifest: `fixtures` → `tasks`, `scorer` → `grader` (with `kind`),
  `limits.repetitions` → `limits.rounds`, and `run.purpose` (`capability` or
  `regression`) is now required;
- result: `repetitions` → `trials` (each trial carries `round` and `taskId`),
  `traces` → `transcripts`, and the version keys follow the new names;
- baselines: re-run and re-promoted. No `2.0.0` eval artifact is valid any more.
