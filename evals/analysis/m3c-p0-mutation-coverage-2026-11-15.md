# M3c P0 — mutation coverage result, 2026-11-15

Layer P0 added `packages/eval-harness`, `tools/eval-harness-cli`,
`tools/agent-harness-bench`, `tools/annotation-kit` and `tools/routing-bench` to
the mutation scope. That took the scored set from 3,089 mutants to 12,786 and
dropped the global score from 95.89/96.24 to 69.60/79.64. This note records how
the scope was brought back over the existing floor, and what could not be
killed honestly.

The scope change and the five entrypoint exclusions are recorded separately in
`evals/analysis/m3c-p0-mutation-scope-2026-11-14.md`.

## Result

`npm run mutation` on `86049ae` (23 min 14 s):

|        | Mutants | Killed | Timeout | Survived | No coverage | Errors |     Total |   Covered |
| ------ | ------: | -----: | ------: | -------: | ----------: | -----: | --------: | --------: |
| Global |  13,223 | 12,257 |      37 |      443 |          49 |     75 | **96.15** | **96.52** |

Timed-out mutants count as killed; runtime errors are excluded, as in
`scripts/mutation-floor.mjs`. The previous global floor was 95.89/96.24, so the
recorded floor rose to 96.15/96.52. No threshold, existing floor or manifest was
changed, and no file beyond the five recorded entrypoints is excluded.

## Per package

| Package                     | Mutants | Killed | Timeout | Survived | No cov | Errors |  Total | Covered |
| --------------------------- | ------: | -----: | ------: | -------: | -----: | -----: | -----: | ------: |
| `apps/cli`                  |     606 |    590 |       0 |       13 |      3 |      0 |  97.36 |   97.84 |
| `packages/eval-harness`     |   6,798 |  6,492 |       6 |      229 |     29 |     42 |  96.18 |   96.60 |
| `packages/persona-kit`      |     349 |    346 |       0 |        2 |      1 |      0 |  99.14 |   99.43 |
| `packages/pipeline`         |     404 |    394 |       6 |        4 |      0 |      0 |  99.01 |   99.01 |
| `packages/routing-policy`   |     419 |    419 |       0 |        0 |      0 |      0 | 100.00 |  100.00 |
| `packages/scenario-kit`     |      23 |     17 |       0 |        0 |      0 |      6 | 100.00 |  100.00 |
| `packages/session-core`     |   1,649 |  1,494 |      15 |      116 |      7 |     17 |  92.46 |   92.86 |
| `packages/shared`           |     312 |    291 |       0 |       20 |      1 |      0 |  93.27 |   93.57 |
| `packages/turn-arbiter`     |     499 |    489 |       0 |        0 |      0 |     10 | 100.00 |  100.00 |
| `tools/agent-harness-bench` |     509 |    478 |       4 |       24 |      3 |      0 |  94.70 |   95.26 |
| `tools/annotation-kit`      |     191 |    189 |       0 |        2 |      0 |      0 |  98.95 |   98.95 |
| `tools/eval-harness-cli`    |   1,036 |    994 |       6 |       31 |      5 |      0 |  96.53 |   96.99 |
| `tools/routing-bench`       |      66 |     64 |       0 |        2 |      0 |      0 |  96.97 |   96.97 |

`packages/session-core`, `packages/shared` and `apps/cli` are unchanged by P0;
their scores differ slightly from the previous baseline because the recorded
baseline predates later session work. `packages/eval-harness` and the four tools
packages now have recorded floors.

## Method

Coverage was raised with tests only: 75 spec files changed and 18 added, with no
source change in the five coverage commits. The rules that kept the score honest:

- whole-object assertions (`toStrictEqual`) where the record is the contract;
- exact schema issue `code`, `path` and `message` for every refinement;
- exact error classes and messages, never `toThrow()` alone;
- mocked producers only where the real one cannot emit the guarded input:
  `readdir` order for `golden.ts` and `validate.ts`, and `replayTask` for the
  `runner.ts` §2.1 transcript guard;
- equivalent or unreachable mutants recorded with a reason instead of asserting
  incidental internals.

## Honest ceilings below 96%

The floor scores each package as a whole, so a file below 96% is acceptable when
its survivors are equivalent. The lowest per-file scores with surviving mutants:

| File                                               | Total | Why it stops                                                                                                                                            |
| -------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks/golden.ts`                                  | 82.28 | comparator branches that only differ for equal keys, `isMissingPathError` conjuncts over real fs errors, `'utf8'` → `''` normalisation                  |
| `tools/eval-harness-cli/src/cli-workspace.ts`      | 85.71 | six `'utf8'` literals, one redundant `catch` return, five defensive `fs` guards                                                                         |
| `tools/agent-harness-bench/src/percentiles.ts`     | 88.14 | unreachable index guard, post-normalisation trim, empty-encoding default                                                                                |
| `runner/task-loader.ts`                            | 91.16 | private `isMissingPathError` guards, redundant directory sorts, stable-sort-equal comparators                                                           |
| `runner/runner.ts`                                 | 83.87 | session-prompt defaults masked by the guard, §2.1 junk-event and content-class operands the producer cannot emit, equivalent shuffle and dispose guards |
| `runner/routing.ts`                                | 94.27 | fallback topology ternaries whose differing field both callers discard, absent-vs-undefined spreads, timer and encoding literals                        |
| `runner/session-runner.ts`                         | 91.91 | shadow `deadlineMs: undefined` behaves like omitted, defensive cancellation branches                                                                    |
| `runner/shadow.ts`                                 | 94.44 | dead `infrastructure_incomplete` guard in the private `sameOutcome`, redundant operands after the kind check, encoding literals                         |
| `tools/agent-harness-bench/src/session-latency.ts` | 94.38 | always-defined timer checks, redundant turn-index guard, dead failure branches                                                                          |
| `jev/grader.ts`                                    | 95.18 | private helpers behind the completed-trial filter, one schema-forbidden `TaskEntry` case                                                                |

Every survivor is listed per module in the coverage reports under
`/tmp/opencode/` during the work; the durable record is this note plus the
per-file scores in `evals/baselines/m1-mutation.json`.

## Findings, not fixed

These were found by the coverage work. P0 is a coverage layer, so each is
recorded for a separate decision.

1. **Malformed task locale crashed `safeParse`.** Fixed in `a84c142`:
   `taskEntrySchema` now checks `tryCanonicalizeLocale` before `Intl.Locale`, so
   an unparsable tag is a schema issue instead of a `RangeError`.
2. **Langfuse span events attach to the parent context.**
   `tools/eval-harness-cli/src/adapters/langfuse.adapter.ts:189-195` creates a
   span's own events with `parentSpanContext` rather than the span's own
   `spanContext()`, so `turn.granted`/`turn.revoked` appear as siblings of the
   turn span on the root instead of inside it.
3. **`requireEnv` returns untrimmed values.**
   `tools/eval-harness-cli/src/live-provider.ts:121-127` validates a trimmed
   value but returns the original, so a padded key reaches the adapter with
   spaces. `optionalEnv` does trim.
4. **`settleWithin` propagates a rejection.**
   `packages/session-core/src/stream-utils.ts:11-22` documents that it resolves
   when the promise settles, but `Promise.race` rethrows a rejection, so a
   rejected `driver.close()` or `model.dispose()` in
   `tools/agent-harness-bench/src/session-latency.ts:249-251` fails the whole
   measurement instead of being treated as settled.
5. **The transcript guard becomes a failed trial.**
   `packages/eval-harness/src/runner/runner.ts:206-222` throws
   `HarnessConfigError` inside the per-trial `try`, so the run records a failed
   trial and keeps scoring, contradicting `runner/errors.ts` ("a configuration
   error is never a failed measurement"). `runner.transcript-guard.spec.ts` pins
   the current behaviour so a fix forces the decision.
