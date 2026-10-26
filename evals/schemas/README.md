# Eval JSON Schemas

Zod is the source of truth. These files are **generated** with
`z.toJSONSchema`; do not edit them by hand.

| File                 | Zod schema          | Validates                |
| -------------------- | ------------------- | ------------------------ |
| `task.schema.json`   | `taskEntrySchema`   | `evals/tasks/**/*.json`  |
| `golden.schema.json` | `goldenEntrySchema` | `evals/golden/**/*.json` |

Source: `packages/eval-harness/src/tasks/schema.ts`
Generator: `packages/eval-harness/src/tasks/generate-schemas.ts`

## Regenerate

```sh
UPDATE_SCHEMAS=1 npx vitest run packages/eval-harness/src/tasks/schema.spec.ts
npx prettier --write evals/schemas
```

The same spec contains the drift test that CI runs: without `UPDATE_SCHEMAS=1`
it only reads the committed files and fails when their parsed contents differ
from `z.toJSONSchema` output. A stale schema therefore cannot land.

## Limits

JSON Schema is used by editors and non-TypeScript tooling; it cannot express
every rule. The following are enforced by the Zod refinements and/or
`validateTaskTree`, not by the committed JSON files:

- a `stable` golden entry requires measured agreement from ≥2 distinct annotators
  (`GOLDEN_AGREEMENT_MISSING`);
- a task may not share a `speakerId` across calibration and holdout
  (`SPLIT_LEAKAGE`);
- `dimensionScores` must not be empty and `annotationVersions` must not be empty;
- ids are unique within their dataset/version/language scope (`DUPLICATE_ID`);
- a golden `taskId` must resolve in the same language/version, and its split must
  match the task's split (`GOLDEN_TASK_MISSING`, `GOLDEN_TASK_SPLIT_MISMATCH`).
