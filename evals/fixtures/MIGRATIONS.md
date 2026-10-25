# Fixture and trace migrations

Required when the shared event/trace schema takes a **breaking** change (a major
bump), per the versioning policy in `packages/session-core/src/version.ts` and
M0 plan D2.

Additive changes (new optional fields, new event kinds, widened enums) only bump
the minor version and need no entry here. A breaking change is not complete
until this file says how stored fixtures and baselines move to the new major
version.

## Format

One section per major version, newest first:

```md
## 2.0.0 — YYYY-MM-DD

- **Breaking:** what changed.
- **Fixtures:** how `evals/fixtures/**` are migrated (script, manual edit, or
  "regenerated from synthetic seeds").
- **Golden/baselines:** whether existing golden entries and committed baselines
  stay valid, or must be re-run and re-promoted.
- **Trace replay:** how old `evals/results/**` traces are read, if at all.
```

## History

No breaking changes yet. The schema starts at `1.0.0`.
