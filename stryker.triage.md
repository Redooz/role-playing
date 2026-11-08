# Mutation baseline and triage

Tool: `@stryker-mutator/core` 10.1.1 with `@stryker-mutator/vitest-runner` 10.1.1.
Command: `npm run mutation` (Stryker) followed by `node scripts/check-mutation-floor.mjs`.

The floor is the **measured** baseline, not a number chosen in advance. The run is
not a PR gate yet; it is a scheduled/on-demand check. Timed-out mutants count as
killed and are reported separately, as the M1 plan requires.

## Baseline (2026-11-08, after the code-review fixes)

| Scope                   | Total  | Covered | Killed | Timeout | Survived | No coverage | Errors |
| ----------------------- | ------ | ------- | ------ | ------- | -------- | ----------- | ------ |
| All files               | 77.68% | 81.20%  | 932    | 18      | 220      | 53          | 17     |
| `packages/session-core` | 83.58% | 84.85%  | 660    | 12      | 120      | 12          | 17     |
| `packages/pipeline`     | 68.86% | 73.36%  | 151    | 6       | 57       | 14          | 0      |
| `apps/cli`              | 63.35% | 73.78%  | 121    | 0       | 43       | 27          | 0      |

Per-file totals are in `reports/mutation/mutation.json` (git-ignored) and in the
M1-G6 row in `evals/decisions.md`.

### Cancellation invariants

`packages/session-core/src/driver.ts` has **no meaningful survivors** in the
cancellation invariants. Its remaining 35 survivors are the equivalent fast
paths and diagnostic strings recorded below. Tests added for this baseline
include exact grant expiry, a silent provider with a non-zero starting clock,
interrupt of a provider that ignores the abort signal, a chunk arriving after
the abort, bounded iterator close, timer cleanup, the history cap, abort-signal
delivery, empty-chunk skipping, and queue delivery/close/failure. It also covers
the version-gated content-class rule, per-record major rejection, and the
invalid-version ordering of `isTranscriptSchemaAtLeast`.

### Documented equivalents in `driver.ts`

| Lines    | Mutant                              | Why it is equivalent                                                                                   |
| -------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 33,39,40 | error message/name strings          | Diagnostics only; `instanceof` classifies errors, not the text.                                        |
| 84,90,93 | `settleWithin` timer clear          | The timer is always defined on entry; clearing an already-cleared timer is harmless.                   |
| 119,127  | queue closed/fail early returns     | Closing or failing an already terminal queue is idempotent.                                            |
| 206,211  | send closed checks                  | A synchronous close is caught by the queue; a late close is caught by the second check.                |
| 212,215  | empty-utterance message / interrupt | The same value is rejected by `trim()`; the message is diagnostic. Interrupting while idle is a no-op. |
| 216,247  | second closed check / interrupt     | Race guards after an awaited interrupt; the first checks cover every synchronous caller.               |
| 261      | history trim overflow               | A negative or zero overflow makes `splice` a no-op; the guard is a fast path.                          |
| 307,310  | deadline/abort promise setup        | The promise value is only a discriminant; the pre-resolved abort fast path lands in the same catch.    |
| 314      | abort listener literals             | `{ once: true }`, the resolve value and the boolean are equivalent for the one-shot race.              |
| 318,330  | loop-top abort / abort race         | The `next()` race and the catch classify the same interruption when the fast path is removed.          |
| 338      | aborted branch                      | Removing the branch falls through to a TypeError caught as `interrupted`; the outcome is identical.    |
| 352,356  | provider-failure reason             | The final reason mapping normalizes both sentinels.                                                    |
| 377,382  | outcome sentinel strings            | The final mapping turns every non-timeout/non-interrupted outcome into `provider_failure`.             |
| 384      | timer clear guard                   | The deadline timer is always defined at this point.                                                    |
| 388      | optional iterator close             | `closeIterator` and `return` are defined on every covered path; the optional guards are defensive.     |

### `events.ts` runtime errors

17 mutants replace parts of the `sessionEventSchema` discriminated union with
`{}` or `""`. The resulting module cannot be imported, so the test runner exits
before a test can fail; Stryker reports this as a `RuntimeError`. They are not
survivors and are excluded from both scores. The payload-coverage test still
asserts one valid and one invalid payload for every event.

### Known limits

- Survivors outside `driver.ts` are recorded by the frozen per-package floor,
  not individually reasoned. They are a backlog, not waived requirements; a
  later change may add tests and raise the floor.
- No live network teardown is in this baseline. The Groq/OpenRouter adapters
  use an injected `fetch`; live provider cleanup remains a trial-isolation gap
  in `AGENTS.md`.
- A mutation score measures whether the tests assert, not whether the behaviour
  is correct. It complements the evals; it is not an eval axis.
