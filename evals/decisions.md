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

| Date       | Gate                         | Run ID                  | Verdict           | Evidence                                                                                                                                                           |
| ---------- | ---------------------------- | ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| _pending_  | G1 canned replay determinism | —                       | —                 | two byte-identical normalised traces per canned EN+FR fixture                                                                                                      |
| _pending_  | G2 manifest enforcement      | —                       | —                 | incomplete manifests rejected with explicit errors                                                                                                                 |
| _pending_  | G3 fixture validator         | —                       | —                 | zero violations in CI                                                                                                                                              |
| 2026-10-25 | G4 Jev integration canary    | `jev-canary-2026-10-25` | accepted (canary) | 3 pre-registered questions; EN yes 0.98, FR yes 0.99, unsettled yes 0.67 (strictly between 0 and 1); served snapshot `typesafe/jev-1.14-20261014`; cost $0.0000465 |
| 2026-10-25 | G5 harness overhead          | `m0-harness-overhead`   | recorded          | p99: dispatch 209 µs, serialization 13.6 µs, append 2.9 µs (500 iterations, Node 26.7.0); `evals/results/m0-harness-overhead/bench.json`; no budget frozen         |
| _pending_  | G6 LiveKit soak              | —                       | —                 | `evals/results/m0-livekit-soak/<runId>.json`                                                                                                                       |

## Accepted and rejected changes

| Date | Change | Run ID | Verdict | Notes                               |
| ---- | ------ | ------ | ------- | ----------------------------------- |
| —    | —      | —      | —       | no behaviour changes exist yet (M0) |
