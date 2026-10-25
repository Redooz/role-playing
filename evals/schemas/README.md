# Eval JSON Schemas

Zod is the source of truth. These files are **generated** with
`z.toJSONSchema`; do not edit them by hand.

| File                  | Zod schema           | Validates                  |
| --------------------- | -------------------- | -------------------------- |
| `fixture.schema.json` | `fixtureEntrySchema` | `evals/fixtures/**/*.json` |
| `golden.schema.json`  | `goldenEntrySchema`  | `evals/golden/**/*.json`   |

Source: `packages/eval-engine/src/fixtures/schema.ts`
Generator: `packages/eval-engine/src/fixtures/generate-schemas.ts`

## Regenerate

```sh
UPDATE_SCHEMAS=1 npx vitest run packages/eval-engine/src/fixtures/schema.spec.ts
npx prettier --write evals/schemas
```

The same spec contains the drift test that CI runs: without `UPDATE_SCHEMAS=1`
it only reads the committed files and fails when their parsed contents differ
from `z.toJSONSchema` output. A stale schema therefore cannot land.

## Limits

JSON Schema is used by editors and non-TypeScript tooling; it cannot express
every rule. The following are enforced by the Zod refinements and/or
`validateFixtureTree`, not by the committed JSON files:

- a `stable` golden entry requires measured agreement from ≥2 distinct annotators
  (`GOLDEN_AGREEMENT_MISSING`);
- a fixture may not share a `speakerId` across calibration and holdout
  (`SPLIT_LEAKAGE`);
- `dimensionScores` must not be empty and `annotationVersions` must not be empty;
- ids are unique within their dataset/version/language scope (`DUPLICATE_ID`).
