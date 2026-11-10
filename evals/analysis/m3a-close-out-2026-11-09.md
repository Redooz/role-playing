# M3a close-out — 2026-11-09

Milestone: **M3a Routing Replay**. Status: **complete**. No routing policy is
adopted or selected; that is M3c.

## Delivered

- `packages/routing-policy`: routing contracts, deterministic central and
  per-persona arms, shared Noul truth table, seeded ranking, central-answer
  validation, and explicit decision assembly.
- Batched Jev transport and bilingual routing questions for central
  Noul + Choice and atomic per-persona Nouls.
- Routing task/golden schemas, 120 synthetic tasks, blind annotation bundle,
  two independent agent passes, 120 draft agent labels, and routing agreement
  tooling.
- Routing replay runner, 2,500 ms complete-decision deadline, same-topology
  deterministic fallback preserved for audit, infrastructure-incomplete
  timeout/transport/schema failures excluded from quality, and restricted exact
  artifacts.
- Matrix aggregator with quality, false-speak/yield, timeout/unsettled fallback,
  latency and honest unknown-cost handling.
- Four-arm holdout comparison and per-language verdicts.

## Gates

| Gate                                  | Result                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| M3a-G1 routing contract               | accepted; routing-policy mutation 100%                                              |
| M3a-G2 labelled dataset               | accepted provisional; 120/120 exact agreement after opaque-id fix                   |
| M3a-G3 exact replay/failure semantics | accepted; restricted exact artifacts and declared fallback                          |
| M3a-G4 timing registration            | accepted; 2,500 ms deadline frozen before holdout                                   |
| M3a-G5 complete 2×2 comparison        | complete; 240 decisions, 0 incomplete; no arm met MDE 0.20; no winner               |
| M3a-G6 regression/mutation            | accepted; M0 and M2 replays clean; global mutation 95.60/95.97; routing-policy 100% |

## Holdout result

| Arm         | EN accepted | FR accepted | Verdict                      |
| ----------- | ----------: | ----------: | ---------------------------- |
| det-central |       1.000 |       1.000 | baseline                     |
| det-persona |       1.000 |       1.000 | target_missed (delta 0)      |
| jev-central |       0.733 |       0.733 | target_missed (delta −0.267) |
| jev-persona |       1.000 |       1.000 | target_missed (delta 0)      |

Jev per-persona fell back deterministically on 93.3% EN / 96.7% FR because of
unsettled Nouls, not timeouts. Jev central false-spoke on 26.7% of tasks in both
languages. No policy was changed to improve the holdout result.

## Limitations

- The synthetic tasks were designed from the same persona/objective features the
  deterministic rules use, so deterministic arms hit a 1.000 ceiling. This
  dataset cannot demonstrate deterministic improvement over deterministic
  routing; it can still expose model-arm failure modes.
- Labels are provisional agent consensus, not blind human ground truth.
- The timing sample is small; P99 is descriptive. D6 holdout provides the larger
  latency sample.
- Jev per-persona's model-only quality is not isolated: its deployed result
  includes the declared fallback.

## Regression

- `m0-canned-replay`: accepted, 12/12 trials, 0 failures, byte-identical replay.
- `m2-persona-replay-v2`: accepted, 12/12 trials, 0 failures, byte-identical
  replay, plain-text invariants pass.
- `validate:tasks`: 0 violations.
- `npm run mutation`: global 95.60% total / 95.97% covered; routing-policy 100%;
  no existing floor lowered.

## Follow-ups

- M3b owns live turn requests, grants, interjections, recovery, streak caps and
  shadow evaluation.
- M3c owns live text A/B and human naturalness review. M3a does not choose a
  policy.
- If the Jev per-persona arm remains too unsettled, calibrate its questions on a
  larger label set before any product adoption.
