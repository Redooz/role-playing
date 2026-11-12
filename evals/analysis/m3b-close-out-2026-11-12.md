# M3b close-out — multi-agent text

Date: 2026-11-12
Status: **D1–D7 implemented; no routing policy adopted.**
Stack: PRs #16–#22 (D1–D7). The user merges every layer and the final stack;
the agent does not merge.

## What shipped

- **D1/D2 — `packages/turn-arbiter`**: a pure reducer for request windows,
  grants, ranking, expiry, interjection, partials, the recovery matrix, the
  streak cap and the invariant fuzz suite.
- **D3 — `session-core` multi-persona driver**: structural arbiter/policy ports,
  one writer per grant, strict grant matching, barge-in revocation, a
  driver-minted greeting and a required replayable seed.
- **D4 — control arm and shadow**: `det-persona`, the `standup-scope-change`
  scenario, `objectives[].personaIds`, the shadow runner and the
  `interruptionWarranted` rubric.
- **D5 — tasks, runner and CLI**: `personaIds` session tasks, 12 tasks per base
  language in a separate dataset, `speakerLabels` goldens, a live multi-persona
  runner with a shadow switch, and `[manager]`/`[peer]` CLI labels with one log.
- **D6 — evidence**: a reducer timing spike, frozen config/budget, a
  fixed-rotation baseline, the `det-persona` candidate, `pass^3` and one shadow
  run. The capability target was not met.
- **D7 — regression and close-out**: M0 and M2 canned replays accepted, full
  mutation with `turn-arbiter` at 100, this report and the AGENTS update.

## Gates

| Gate                                  | Result                           | Evidence                                                                                                                  |
| ------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| M3b-G1 arbiter contract               | pass                             | Pure reducer tests, structural port tests, `turn-arbiter` 100/100 mutation                                                |
| M3b-G2 invariants under fuzzing       | pass                             | Seeded 1,000-input fuzz suite plus seven targeted families                                                                |
| M3b-G3 recovery matrix                | pass                             | Five recovery rows, bounded replacement, no grant spin                                                                    |
| M3b-G4 live multi-persona session     | pass                             | Two-persona CLI/runner, one grant at a time, stale output dropped, §3.2 guard clean, single-persona replay byte-identical |
| M3b-G5 timing and budgets             | pass                             | `evals/results/m3b-timing/timing.json`; frozen `M3B_BUDGETS`                                                              |
| M3b-G6 capability and shadow evidence | pass as evidence, target not met | 18/18 trials per arm/language, zero incompletes; English rejected, French inconclusive; 144 shadow records                |
| M3b-G7 regression and mutation        | pass                             | `m0-canned-replay` and `m2-persona-replay-v2` accepted; every mutation floor held                                         |

## Capability finding

| Language | Fixed rotation | `det-persona` | Delta  | MDE  | Verdict      |
| -------- | -------------- | ------------- | ------ | ---- | ------------ |
| English  | 0.750          | 0.667         | −0.083 | 0.20 | rejected     |
| French   | 0.583          | 0.667         | +0.083 | 0.20 | inconclusive |

`det-persona` is not better than fixed rotation on this sample. The target is
not met in either language. No routing policy is adopted; M3c can revisit it.

## Mutation

Latest full run: global **96.32 / 96.53**. `turn-arbiter` **100.00 / 100.00**;
`routing-policy` **100.00 / 100.00** (including `fixed-rotation.ts`);
`apps/cli` **97.36 / 97.84**; `session-core` **93.06 / 93.30** (floor
91.96 / 92.24); `persona-kit` **99.14 / 99.43**; `shared` **93.27 / 93.57**;
`pipeline` **99.01 / 99.01**; `scenario-kit` **100.00 / 100.00**. No floor was
lowered and the baseline file was not re-recorded.

## Gaps and findings

1. **Capability target missed.** English regressed; French improved below the
   MDE. Recorded, not softened.
2. **Speaker-label agreement 0.75 per language** against a pre-registered 0.80.
   The labels stay `draft` / `agent`. See
   `evals/analysis/m3b-d5-label-agreement-2026-11-11.md`.
3. **Eval-harness is outside the mutation gate.** The shadow runner, live
   session runner and turn-taking grader live in `packages/eval-harness`, which
   `AGENTS.md` does not list in the mutation-gated set. Adding the whole package
   needs its own measured floor and is not smuggled in. The `turn-arbiter` and
   `routing-policy` parts are at 100.
4. **Capability spend is not metered.** The eval runner records no cost for the
   live Gemma sessions. The shadow run cost $0.0056; the combined M3b total is
   recorded as **unmeasured**, not claimed under the $5 cap.
5. **Pass^k is pass^1/pass^3 at one task split.** The r3 runs provide `pass^3`
   for the holdout tasks; they do not estimate variance across a larger task
   sample.

## Final state

- `npm run test:unit`: 1,434 passed / 1 skipped.
- `npm run validate:tasks`: 0 violations.
- `npm run lint`, `format:check`, `typecheck`: clean.
- The stack is open. The user merges it; the agent never merges.
