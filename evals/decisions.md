# Decision log

Human-readable record of every accepted, rejected or inconclusive eval, per
Architecture Plan v5 §4.1.8. One row per decision; the raw numbers live in the
run directory it points at.

Rules:

- **Evals decide.** A feature is accepted because a pre-registered run says so,
  not because the code looks right.
- **Never rewrite history.** If a decision changes, add a new row that points
  at the run which overturned it.
- **A failed model call is not a "no".** Provider outages are recorded as
  `infrastructure_inconclusive`, never as a rejection of the feature.
- **No composite scores.** Per-axis deltas are reported as-is (§4.1.7).

## M0 gates

M0 is scaffolding, so these gates are about reproducibility and workflow
integrity, not product quality. They are the first entries in this log.

| Date       | Gate                         | Run ID                          | Verdict           | Evidence                                                                                                                                                                                                         |
| ---------- | ---------------------------- | ------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-25 | G1 canned replay determinism | `m0-canned-replay`              | accepted          | 2 full CLI runs, 12 normalised traces (6 EN + 6 FR, both splits) byte-identical; manifest sha256 `76cec20f…4b51be`; only wall-clock metadata differs                                                             |
| 2026-10-25 | G2 manifest enforcement      | `m0-canned-replay`              | accepted          | 10 required manifest sections, each deleted in turn: explicit `"<section>: missing required field"`, exit 2, nothing executed, no results directory created                                                      |
| 2026-10-25 | G3 fixture validator         | `validate-fixtures`             | accepted          | 0 violations on the committed tree; `SPLIT_LEAKAGE`, `MISSING_PROVENANCE`, `LANG_PATH_MISMATCH`, `DUPLICATE_ID`, `GOLDEN_AGREEMENT_MISSING` all covered by tests; CI job `fixture validator (G3)` green on PR #1 |
| 2026-10-25 | G4 Jev integration canary    | `jev-canary-2026-10-25`         | accepted (canary) | 3 pre-registered questions; EN yes 0.98, FR yes 0.99, unsettled yes 0.67 (strictly between 0 and 1); served snapshot `typesafe/jev-1.14-20261014`; cost $0.0000465                                               |
| 2026-10-25 | G5 harness overhead          | `m0-harness-overhead`           | recorded          | p99: dispatch 209 µs, serialization 13.6 µs, append 2.9 µs (500 iterations, Node 26.7.0); `evals/results/m0-harness-overhead/bench.json`; no budget frozen                                                       |
| 2026-10-25 | G6 LiveKit soak              | `soak-2026-10-25T17-55-13-434Z` | accepted          | 10/10 cycles × 20 min, 1,199,607 frames received, 0 crashes, 0 reconnects, handles 0→0, dispose 4–6 ms; RSS +70.3 MB over 200 min with flat JS heap (18.8→18.4 MB) and inter-cycle step growth noted             |

## Accepted and rejected changes

| Date | Change | Run ID | Verdict | Notes                               |
| ---- | ------ | ------ | ------- | ----------------------------------- |
| —    | —      | —      | —       | no behaviour changes exist yet (M0) |
