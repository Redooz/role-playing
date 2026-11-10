# Mutation baseline and triage

Tool: `@stryker-mutator/core` 10.1.1 with `@stryker-mutator/vitest-runner` 10.1.1.
Command: `npm run mutation` (Stryker) followed by `node scripts/check-mutation-floor.mjs`.

The floor is the **measured** baseline, not a number chosen in advance. Timed-out
mutants count as killed and are reported separately. Per-package scores are the
gate; the global number is a summary. `evals/baselines/m1-mutation.json` is the
current measured floor after the M3a D1 routing-policy pass.

## Score before and after

| Scope                     | Before total / covered | After total / covered | Killed | Timeout | Survived | No coverage | Errors |
| ------------------------- | ---------------------- | --------------------- | ------ | ------- | -------- | ----------- | ------ |
| **Global**                | **68.21 / 72.74**      | **95.49 / 95.87**     | 2674   | 17      | 116      | 11          | 23     |
| `apps/cli`                | 57.49 / 71.36          | **95.95 / 97.13**     | 474    | 0       | 14       | 6           | 0      |
| `packages/persona-kit`    | 31.94 / 34.19          | **99.13 / 99.42**     | 341    | 0       | 2        | 1           | 0      |
| `packages/pipeline`       | 74.01 / 77.66          | **99.01 / 99.01**     | 394    | 6       | 4        | 0           | 0      |
| `packages/routing-policy` | n/a                    | **99.65 / 99.65**     | 285    | 0       | 1        | 0           | 0      |
| `packages/session-core`   | 85.77 / 86.85          | **91.96 / 92.24**     | 881    | 11      | 75       | 3           | 17     |
| `packages/shared`         | 61.86 / 63.49          | **93.27 / 93.57**     | 291    | 0       | 20       | 1           | 0      |
| `packages/scenario-kit`   | 75.00 / 75.00          | **100.00 / 100.00**   | 8      | 0       | 0        | 0           | 6      |

Global and five of seven packages meet 95%. `session-core` (91.96/92.24) and
`shared` (93.27/93.57) do **not**. The remaining gap is 30 kills in
`session-core` and 6 in `shared`. Neither gap can be closed without violating the
stated scope: see [Remaining gap](#remaining-gap).

`stryker.config.json` now uses a 95 break threshold; this raises the old 68.21
break threshold and does not lower any floor.

## What the added tests cover

The pass is organised by survivor class, not by one large test:

- **`shared/plain-text.ts`**: tilde fences and every reference-link shape;
  heading/quote/list whitespace variants; single-pipe table delimiter rows with
  leading/trailing pipes, alignment colons, 3/4 dashes, spaces and trailing
  text; attribute-bearing HTML tags; escaped and non-escaped backslashes; CRLF,
  lone CR, whitespace runs and 3+ blank lines; keycaps without U+FE0F, flags,
  ZWJ clusters, non-pictographic joins, skin-tone-after-ZWJ and lone residue;
  streaming sentence/newline boundaries, multiple whitespace and newline
  characters, a leading-space buffer, the exact 320-character buffer bound, the
  48-character tail guard, a filtered-empty segment and a start-of-line newline
  separator.
- **`shared/locale.ts`**: exact typed error name/tag and messages; empty and
  whitespace tags; Intl parse failures; a mocked no-canonical-tag runtime;
  unsupported base language; `tryCanonicalizeLocale` success/failure; canonical
  equality.
- **`persona-kit`**: golden prompt snapshots for all 3 personas × 4 locales ×
  2 styles (packs, system prompts and hashes); pinned version constants and every
  locale convention line; pinned-date boundary variants; exact prompt-variant
  diagnostics; a non-variant lookup failure; scenario/persona mismatch and
  opening mismatch; a synthetic `en-AU` locale with no regional convention; empty
  avoid/example lists and `questionPolicy: none`; both required disclosures;
  Gemma sentence punctuation (`...`, `!?`, `…`, `?` mid-sentence), capitalisation
  of lowercase/uppercase/empty/`é` tone, and example rendering.
- **`pipeline`**: OpenAI-compatible pre-response failure timing, abort pass-through,
  non-2xx and null body, blank/comment SSE lines, null `finish_reason`, role-only
  deltas, empty content, multibyte UTF-8 split across chunks, SSE line trimming,
  reader cancellation, every timing-field optional branch, every usage field,
  `x_groq` precedence, empty/non-object usage, malformed/non-object data lines and
  every generation body field (including an exported `bodyForGeneration` unit
  test); exact Groq/OpenRouter/LiveKit constants, cause/status handling,
  whitespace-only credentials, default attribution title, default LiveKit clock
  and token lifetime; plain-text decorator empty chunks, stats on an unterminated
  provider, missing `dispose`, and generation profiles.
- **`session-core`**: guard diagnostics for every violation class, repeated
  revocation, empty grant ids, started-event validation, sparse sequence lists,
  multi-violation messages; transcript payload/content-class issue codes, paths
  and messages; log header JSON errors, root-path issues, header-only logs,
  exact version errors and line numbers; driver default clock/persona/TTL, direct
  second-send supersession, abort during `complete()`, locale metadata omission,
  exact `start()` misuse, absent `partialText`/`detail`, a cancel during a
  blocked iterator close, the bounded close wait and deadline timer cleanup.
- **`apps/cli`**: a mocked composition-root suite covering help, canned and live
  paths, task/header stamps, locale canonicalisation, every argument failure,
  printable-bound truncation and control escaping, prompt-date boundaries, gemma
  version stamping, log creation failure, REPL failure, dispose failure, missing
  dispose, default/blank inference URL and TTY detection; REPL coverage for every
  help line, blank/CRLF input, send failure, all five cancellation labels,
  committed/empty/cancelled/session-completed rendering, default file reader,
  replay with/without partial text, truncation, unterminated logs, and
  committed/cancelled grants not leaking into unfinished replay output; header
  write encoding is pinned with a mocked `node:fs/promises`.

## Remaining gap

| Package                 | Gap to 95 total        | Why the gap remains                                                                                                                                                                                                                                                                                                   | Smallest next step                                                                                                                                                                                                |
| ----------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/session-core` | 91.96; needs +30 kills | 17 survivors are `events.ts` enum/literal schema definitions; 8 are `session-log.ts` Zod field schemas; 1 is the `version.ts` schema message; 2 are equivalent `readSchemaVersion` guards; 4 are equivalent guard/loop guards. The remaining 40 driver survivors are redundant race/defensive paths documented below. | If schema literals are allowed back into scope, event-vocabulary and header-bound contract tests would add 26 kills and clear 95. Under the stated “no static data / Zod schema” rule, the honest floor is 91.96. |
| `packages/shared`       | 93.27; needs +6 kills  | 19 `plain-text.ts` survivors are equivalent under the normaliser or are shadowed by the following line (table rows with 2+ pipes are removed by the generic table-row rule); 1 `locale.ts` catch block falls through to the same `undefined` result.                                                                  | Add Unicode line-separator (U+2028/U+2029) table cases to distinguish the three `^…$` table-row mutants, and either refactor the redundant `groups[1] ?? ''` fallback or accept the 93.27 floor.                  |

The global total is 95.49/95.87 because the other packages are far above 95
(`persona-kit` 99.13, `pipeline` 99.01, `routing-policy` 99.65,
`scenario-kit` 100.00, `apps/cli` 95.95).

## Equivalent-mutant inventory

Line numbers are from the recorded run. A group entry covers every mutant listed
for that line in `reports/mutation/mutation.json`.

### `packages/session-core/src/driver.ts` (40 survivors + 3 no-coverage)

| Lines              | Mutant class                                                    | Why it is equivalent                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 288, 289, 293, 294 | `start()` closed/active checks and the `await interrupt()` call | `start()` cannot have `#active` set before its own first await (the turn counter guard fires first), and the closed check is repeated immediately after the interrupt. |
| 300, 304, 305      | `send()` closed/active checks and interrupt call                | The post-interrupt closed check duplicates the pre-send check; `interrupt()` on no active turn is already a no-op.                                                     |
| 123                | `settleWithin` timer-clear guard                                | The timer is always defined on entry; clearing it unconditionally is harmless.                                                                                         |
| 168                | queue max-items outer guard                                     | With no limit, `length >= undefined` is false, so the fail branch cannot run.                                                                                          |
| 180                | queue close early return                                        | Closing an already-closed queue is idempotent.                                                                                                                         |
| 275                | default queue limit `??` vs `&&`                                | The default only matters above 100,000 undelivered events; the bound itself is covered by the queue unit tests.                                                        |
| 340                | shared closing-promise early return                             | The queue is already closed, so a second `session.completed` is not observable.                                                                                        |
| 362, 363           | history-trim arithmetic and `removable <= 0` guard              | `overflow <= removable` whenever a trim is possible, so `splice` removes the same records.                                                                             |
| 439                | deadline sentinel string                                        | `deadline.then` ignores the resolved value.                                                                                                                            |
| 442, 443, 450, 451 | already-aborted fast path and loop-top abort check              | The aborted promise and the loop-top check are redundant with each other and with the post-race outcome mapping.                                                       |
| 446                | abort listener sentinel, options and `once` flag                | The sentinel value is ignored; a signal aborts once, so an auto-removed listener and a persistent listener are observationally identical.                              |
| 465                | aborted-race arrow/object literal                               | A malformed race result falls through to the same aborted outcome or is converted to an interrupted outcome by the catch.                                              |
| 473                | aborted branch body/sentinel                                    | The same abort is caught by the top-of-loop check; a changed sentinel is normalised to `interrupted`.                                                                  |
| 487, 492, 514, 523 | `provider_failure` sentinels                                    | The final reason mapping turns every non-timeout/non-interrupted outcome into `provider_failure`.                                                                      |
| 520, 521           | catch-after-abort branch                                        | The post-loop `committed && aborted` check already maps this case to `interrupted`.                                                                                    |
| 527                | unconditional timer clear                                       | Clearing an already-cleared timer is harmless.                                                                                                                         |
| 531                | optional iterator `return`                                      | A missing `return` is explicitly allowed by the port; the close is defensive.                                                                                          |

### `packages/session-core/src/events.ts` (17 survivors)

Not equivalent: they are enum values, event-name literals and a schema refinement
flag. They are **deliberately untargeted** because the task excludes Zod schema
definitions and static vocabulary data. The 17 `RuntimeError` mutants are schema
shapes that cannot be imported and are excluded from the score by Stryker.

### `packages/session-core/src/session-log.ts` (9 survivors)

- Lines 65–71 (6 mutants): `z.string().min(1)` → `max(1)` on optional header
  fields. Zod schema definition, deliberately untargeted.
- Line 57 (2 mutants): `startedAt` ISO-datetime schema construction, same reason.
- Line 157 (`issue.path.join('.')` separator): header field paths are always
  single-segment, so the separator is never observable. Equivalent.

### `packages/session-core/src/transcript.ts` (2 survivors)

- Lines 186, 188: `readSchemaVersion` type guards. Any non-string/`null` value
  either throws from the same property access or is filtered by
  `transcriptSchemaVersionSchema.safeParse`, so the subsequent `ZodError` is the
  same. Equivalent.

### `packages/session-core/src/version.ts` (3 survivors)

- Lines 67, 70: loop bound `<= length` and `a >= b`. The loop has exactly three
  components, and `a !== b` is checked before the comparison, so both mutations
  produce the same result. Equivalent.
- Line 93: Zod regex message. Schema definition, deliberately untargeted.

### `packages/session-core/src/guards.ts` (4 survivors)

- Line 161: unconditional `currentGrant = undefined` on revocation. A grant can
  only be current under its own id, and re-revocation exits earlier. Equivalent.
- Line 221: `last !== undefined` replaced by `true`; the inner `sequence <= last`
  is false when `last` is undefined. Equivalent.
- Line 249: `default:` branch; non-grant events leave the ledger unchanged.
  Equivalent.
- Line 289: `index <= records.length`; one extra iteration reads an undefined
  record and is skipped by the next guard. Equivalent.

### `packages/shared/src/locale.ts` (1 survivor)

- Line 82: empty catch body in `tryCanonicalizeLocale`; falling through still
  returns `undefined`. Equivalent.

### `packages/shared/src/plain-text.ts` (19 survivors + 1 no-coverage)

- Line 66: `groups[1] ?? ''` fallback. Every replacement pattern has capture
  group 1, so the fallback is unreachable. Equivalent.
- Lines 97, 99: single-space class after heading/list markers. The normaliser
  collapses the remaining whitespace and trims the line start. Equivalent.
- Line 104 (2 mutants): non-space prefix before the first cell, and a single
  separator cell. Any input that distinguishes the first needs two pipes, which
  the next table-row rule removes; the single-cell case is shadowed by the same
  rule. Equivalent.
- Line 106 (3 mutants): removing `^`, `$`, or negating leading spaces. The rule
  removes an entire 2+ pipe line either way; a leftover line terminator is
  trimmed. Equivalent.
- Lines 109, 110: `[\S\s]` vs `[\s\S]` matches exactly the same characters.
  Equivalent.
- Line 137: one space vs a run of spaces before `.`/`,`. The preceding
  whitespace collapse leaves exactly one space. Equivalent.
- Line 176: `\n+` vs `\n` under `matchAll` still reports the last newline index.
  Equivalent.
- Line 184: `candidate >= end` vs `>`. Both match ends are positive and the
  initial end is zero. Equivalent.
- Line 208: empty-chunk fast path; `buffer += ''` and a zero boundary produce the
  same empty string. Equivalent.
- Line 215: `whitespace >= 0` vs `> 0`. A zero index can only mean a leading
  space, whose emitted segment sanitises to empty. Equivalent.
- Lines 218, 223, 224: zero-cut flush, empty-flush and `last` boolean guards.
  Each path returns the same `''`/`#emit` result. Equivalent.
- Line 231: `#emitted.trim().length` vs `#emitted.length`; emitted text never
  begins or consists solely of whitespace. Equivalent.

### `packages/persona-kit/src/prompt/template-gemma.ts` (2 survivors + 1 no-coverage)

- Line 127: empty-text short-circuit and optional chaining/fallback. The
  short-circuit returns the empty string before the optional access, and every
  non-empty string has a first character. Equivalent.

### `packages/routing-policy/src/rank.ts` (1 survivor)

- Line 34: `leftTie < rightTie` vs `<=` in the final seeded tie-break. The
  equality case is handled on the preceding line, so no two distinct personas
  reach the mutated comparison with equal SHA-256 hashes. Equivalent.

### `packages/pipeline/src/openai-compatible.ts` (2 survivors)

- Line 149: `line === ''` is redundant because the following `!startsWith('data:')`
  skips the same blank line; the `'data:'` literal mutation leaves the parser
  with no valid frames, which is the same failure boundary. Equivalent.

### `packages/pipeline/src/plain-text.adapter.ts` (2 survivors)

- Line 68: `chunk.text.length > 0` vs always-true/`>= 0`. Filtering an empty push
  returns `''`, so no output is produced either way. Equivalent.

### `apps/cli/src/main.ts` (9 survivors + 6 no-coverage)

- Line 95 (7 mutants): the path-escape guard after `resolve()` is unreachable
  because `SESSION_ID_PATTERN` cannot contain `/`, `..` or a separator; the
  defence-in-depth branch is never entered. Equivalent under the public API.
- Line 225: always-validate condition. A missing override stringifies to
  `"undefined"`, which passes the pattern, so no extra rejection occurs.
  Equivalent.
- Line 361: first `undefined` comparison in `nonEmptyEnv`; the empty-string arm
  still handles an undefined value. Equivalent.
- Lines 151, 157: `?? 'canned'` / `?? 'en'` defaults; `parseArgs` always supplies
  them. Unreachable no-coverage.
- Lines 239, 240: `resolveSessionLogPath` catch; the id pattern makes the throw
  unreachable. Unreachable no-coverage.

### `apps/cli/src/cli-main.ts` (5 survivors)

- Line 96: `persona.response.started` case label replaced by `''`; falling to
  `default` has the same no-output behaviour. Equivalent.
- Line 120: setting `lineOpen = false` inside `if (lineOpen)` is idempotent.
  Equivalent.
- Lines 123, 250: `default:` branches; unknown/non-rendered events are ignored.
  Equivalent.
- Line 186: `.finally(() => pending.delete(sending))`; the cleanup only affects
  memory after the send has settled, not the awaited result. Equivalent.

## Known limits

- No live network teardown is in this baseline. The Groq/OpenRouter/LiveKit
  adapters use an injected `fetch`; live provider cleanup remains a trial
  isolation gap in `AGENTS.md`.
- A mutation score measures whether the tests assert, not whether the behaviour
  is correct. It complements the evals; it is not an eval axis.
- The `session-core` and `shared` package floors are recorded at their measured
  values (91.96 and 93.27 total) and are not lowered from the previous baseline;
  they are the honest ceiling under the declared schema/static-data exclusion.
