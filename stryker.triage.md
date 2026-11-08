# Mutation baseline and triage

Tool: `@stryker-mutator/core` 10.1.1 with `@stryker-mutator/vitest-runner` 10.1.1.
Command: `npm run mutation` (Stryker) followed by `node scripts/check-mutation-floor.mjs`.

The floor is the **measured** baseline, not a number chosen in advance. The run is
not a PR gate yet; it is a scheduled/on-demand check. Timed-out mutants count as
killed and are reported separately, as the M1 plan requires.

## Baseline (2026-11-07, re-measured after PR #5 review fixes)

| Scope                   | Total  | Covered | Killed | Timeout | Survived | No coverage | Errors |
| ----------------------- | ------ | ------- | ------ | ------- | -------- | ----------- | ------ |
| All files               | 73.33% | 78.73%  | 819    | 14      | 225      | 78          | 17     |
| `packages/session-core` | 80.25% | 83.12%  | 573    | 8       | 118      | 25          | 17     |
| `packages/pipeline`     | 68.86% | 73.36%  | 151    | 6       | 57       | 14          | 0      |
| `apps/cli`              | 51.63% | 65.52%  | 95     | 0       | 50       | 39          | 0      |

Per-file totals are in `reports/mutation/mutation.json` (git-ignored) and in the
M1-G6 row in `evals/decisions.md`.

### Cancellation invariants

`packages/session-core/src/driver.ts` has **no meaningful survivors** in the
cancellation invariants. Its remaining 21 survivors are recorded below as
equivalents. Tests added for this baseline: exact grant-expiry boundary, empty
chunk, usage carried from an earlier chunk, interrupt before commit, partial
context, immediate cancel with no empty assistant message, synchronous
`complete()` throw, non-string chunk, throw after abort, and iterator `return`
on an aborted stream. The re-measured baseline also covers the version-gated
content-class rule (`1.0.0` records stay readable, `1.1.0+` records are checked)
and the invalid-version ordering of `isTranscriptSchemaAtLeast`.

### Documented equivalents in `driver.ts`

| Line | Mutant                    | Why it is equivalent                                                                                            |
| ---- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 33   | error message string      | Diagnostics only; no control flow depends on the message.                                                       |
| 39   | error message string      | Same.                                                                                                           |
| 40   | error `name` string       | `instanceof` is used for classification, not `name`.                                                            |
| 86   | queue closed check        | A closed queue drops pushes; no observer can see the difference.                                                |
| 96   | queue close early return  | Closing an already closed queue is idempotent.                                                                  |
| 116  | failure check             | A closed queue with no failure resolves `done`; the failure path is already terminal.                           |
| 178  | `taskId` ternary          | `taskId: undefined` and an absent key are the same to the optional schema and to `toEqual`.                     |
| 183  | first closed check        | The second closed check (`188`) catches the same call sequence; the queue is also closed.                       |
| 184  | empty-string literal      | The same value is rejected by `trim()`; the message is diagnostic.                                              |
| 187  | interrupt active check    | Interrupting while idle is a documented no-op.                                                                  |
| 188  | second closed check       | A race guard after an awaited interrupt; the first check covers every synchronous caller.                       |
| 219  | close early return        | A second `session.completed` is dropped by the already-closed queue.                                            |
| 268  | loop-top abort check      | The post-`next()` check and the catch handle abort-respecting providers; the loop-top check is a fast path.     |
| 287  | `outcome` sentinel        | The final reason mapping turns every non-timeout/non-interrupted outcome into `provider_failure`.               |
| 291  | `outcome` sentinel        | Same.                                                                                                           |
| 308  | inner committed check     | Once the loop exits, the outcome is committed or already classified; the guard is redundant.                    |
| 312  | `outcome` sentinel        | Same reason mapping as 287.                                                                                     |
| 317  | `provider_failure` string | The final mapping normalizes it; the interrupted branch is asserted separately.                                 |
| 319  | `iterator.return` guard   | A missing `return` is optional; the inner `try` swallows a TypeError when the guard is bypassed.                |
| 319  | `iterator.return` guard   | Same; removing the call only matters for a provider whose `return` has side effects, which the contract allows. |
| 332  | usage spread              | `usage: undefined` is optional to the schema and to `toEqual`; the JSON writer drops it.                        |

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
