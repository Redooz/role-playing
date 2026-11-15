# M3c P0 mutation scope — 2026-11-14

Status: **applied as a scope exclusion on 2026-11-14.** No baseline is recorded
yet. The remaining scope must reach the global floor through test work before
`npm run mutation:record` writes a new `evals/baselines/m1-mutation.json`.

## What was measured

`npx stryker run` on `664639c` instrumented 141 files with 13,223 mutants. The
global score was **69.60% total / 79.64% covered** against the recorded floor
**95.89 / 96.24**. The eight packages that already had a floor scored
**96.05 / 96.32**; no existing package floor was lowered.

## The decision

Five files are **direct-execution entrypoints**. A command starts each one in a
separate Node process, not in the Vitest process. Stryker changes the code in
the Vitest process only. It cannot see coverage for a file that no test imports,
and a test that starts a child process does not activate the mutant in that
process.

| File                                        | Mutants | Status          |
| ------------------------------------------- | ------: | --------------- |
| `tools/eval-harness-cli/src/cli.ts`         |      38 | 0%, no coverage |
| `tools/routing-bench/src/compare.ts`        |      34 | 0%, no coverage |
| `tools/routing-bench/src/compare-main.ts`   |     174 | 0%, no coverage |
| `tools/routing-bench/src/m3b-shadow.cli.ts` |      34 | 0%, no coverage |
| `tools/routing-bench/src/m3b-shadow.ts`     |      86 | 0%, no coverage |

They are excluded from `stryker.config.json` `mutate`. The exclusion is a
measurement correction, not a pass for a feature: these files cannot produce a
meaningful mutation score under the current per-test harness.

No other file is excluded. `apps/cli/src/cli.ts` was already outside the
`mutate` scope for the same reason.

## What remains

After the exclusion the scored scope is 8,546 mutants. The new packages are
still well below the floor:

| Package                     | Score before the exclusion |    Floor |
| --------------------------- | -------------------------: | -------: |
| `packages/eval-harness`     |              62.87 / 71.22 | none yet |
| `tools/eval-harness-cli`    |              35.94 / 58.05 | none yet |
| `tools/routing-bench`       |              12.18 / 73.85 | none yet |
| `tools/agent-harness-bench` |              50.29 / 64.00 | none yet |
| `tools/annotation-kit`      |              81.15 / 83.78 | none yet |

The global floor is unchanged. Tests must raise the remaining scope to the
floor. The entrypoints are the only files excluded from that target.

## Rules kept

- `stryker.config.json` `thresholds` is unchanged (`high 96 / low 95 / break 95`).
- `evals/baselines/m1-mutation.json` is unchanged until a clean run passes.
- No existing package floor is lowered.
- A new baseline is written only by `npm run mutation:record` after a clean run.

## Revisit condition

If an entrypoint is refactored into an exported function and an in-process test
calls it, remove its exclusion and re-measure. Do not keep an exclusion after
the file becomes coverable.
