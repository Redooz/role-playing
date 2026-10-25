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

| Date | Gate | Run ID | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| _pending_ | G1 canned replay determinism | — | — | two byte-identical normalised traces per canned EN+FR fixture |
| _pending_ | G2 manifest enforcement | — | — | incomplete manifests rejected with explicit errors |
| _pending_ | G3 fixture validator | — | — | zero violations in CI |
| _pending_ | G4 Jev integration canary | — | — | EN, FR and unsettled smoke questions |
| _pending_ | G5 harness overhead | — | — | `evals/results/m0-harness-overhead/bench.json` |
| _pending_ | G6 LiveKit soak | — | — | `evals/results/m0-livekit-soak/<runId>.json` |

## Accepted and rejected changes

| Date | Change | Run ID | Verdict | Notes |
| --- | --- | --- | --- | --- |
| — | — | — | — | no behaviour changes exist yet (M0) |
