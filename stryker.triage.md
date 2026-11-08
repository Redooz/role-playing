# Mutation baseline and triage

Tool: `@stryker-mutator/core` 10.1.1 with `@stryker-mutator/vitest-runner` 10.1.1.
Command: `npm run mutation` (Stryker) followed by `node scripts/check-mutation-floor.mjs`.

The floor is the **measured** baseline, not a number chosen in advance. The run is
not a PR gate yet; it is a scheduled/on-demand check. Timed-out mutants count as
killed and are reported separately, as the M1 plan requires.

## Baseline (2026-11-08, after the round-2 review fixes)

| Scope                   | Total  | Covered | Killed | Timeout | Survived | No coverage | Errors |
| ----------------------- | ------ | ------- | ------ | ------- | -------- | ----------- | ------ |
| All files               | 79.21% | 82.40%  | 1086   | 19      | 236      | 54          | 17     |
| `packages/session-core` | 84.67% | 85.79%  | 766    | 13      | 129      | 12          | 17     |
| `packages/pipeline`     | 70.75% | 74.90%  | 173    | 6       | 60       | 14          | 0      |
| `apps/cli`              | 66.22% | 75.77%  | 147    | 0       | 47       | 28          | 0      |

Per-file totals are in `reports/mutation/mutation.json` (git-ignored) and in the
M1-G6 row in `evals/decisions.md`.

### Cancellation invariants

`packages/session-core/src/driver.ts` has **no meaningful survivors** in the
cancellation invariants. Its remaining 40 survivors are the equivalent fast
paths and diagnostic strings recorded below. Tests added for this baseline
include exact grant expiry and abort on clock expiry, a silent provider with a
non-zero starting clock, interrupt of a provider that ignores the abort signal,
a chunk arriving after the abort, bounded iterator close, timer cleanup, the
history cap and user-first trimming, abort-signal delivery, empty-chunk
skipping, queue overflow, a shared closing promise, grant-TTL validation, and
the bounded provider-failure detail. It also covers the content-class rule for
every text-bearing event kind, per-record major rejection, the version-before-
payload parse order, and the invalid-version ordering of
`isTranscriptSchemaAtLeast`.

### Documented equivalents in `driver.ts`

Line numbers are from this run.

| Lines                   | Mutant                           | Why it is equivalent                                                                                                 |
| ----------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 33,39,40                | error message/name strings       | Diagnostics only; `instanceof` classifies errors, not the text.                                                      |
| 92,98,101               | `settleWithin` timer clear       | The timer is always defined on entry; clearing an already-cleared timer is harmless.                                 |
| 109,110                 | failure-detail formatting        | Diagnostic only. The tests pin a single line and the 200-character bound; the rest changes spelling.                 |
| 146                     | queue waiter fast path           | The pending-reader and buffered paths are both tested; the remaining branch is a fast path.                          |
| 158,166                 | queue closed/fail early returns  | Closing or failing an already terminal queue is idempotent.                                                          |
| 244                     | queue-limit defaulting           | The bound is tested directly on the queue; the default only differs for an invalid zero limit, which throws.         |
| 252,257,258             | send closed/empty checks         | A synchronous close is caught by the queue; the same empty value is rejected by `trim()`; the message is diagnostic. |
| 261,262                 | interrupt/second closed check    | Race guards after an awaited interrupt; the first checks cover every synchronous caller.                             |
| 293,310,315             | history trim fast paths          | A non-positive overflow makes `splice` a no-op; the assistant-first loop is covered by the max-4 test.               |
| 367,370,374,378         | cancellation detail strings      | The final reason mapping normalizes the sentinels; the detail branches are diagnostic and separately tested.         |
| 393,401,415,420         | iterator close/outcome sentinels | The final mapping turns every non-timeout/non-interrupted outcome into `provider_failure`.                           |
| 442,448,451,455,459,492 | reason/detail/close paths        | The provider-failure and timeout reasons are asserted; the optional iterator close is defensive.                     |

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
