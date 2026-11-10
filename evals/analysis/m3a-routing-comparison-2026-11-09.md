# M3a routing comparison — 2026-11-09

Registered split: **holdout only**. 60 tasks per arm (30 English, 30 French), 240
complete decisions. Deadline: 2,500 ms. MDE: **0.20** on
`routing.acceptable_outcome_rate`, separately per language. Baseline:
`det-central`. Cost: **$0.0085**, inside the $5 cap. Incomplete trials: **0**.

## Matrix

| Arm         | Lang |   n | Accepted rate | False speak | False yield | Timeout | Unsettled fallback | p50 ms | p95 ms | p99 ms |
| ----------- | ---- | --: | ------------: | ----------: | ----------: | ------: | -----------------: | -----: | -----: | -----: |
| det-central | en   |  30 |         1.000 |       0.000 |       0.000 |   0.000 |              0.000 |    0.2 |    5.2 |   10.2 |
| det-central | fr   |  30 |         1.000 |       0.000 |       0.000 |   0.000 |              0.000 |    0.2 |    3.8 |    8.4 |
| det-persona | en   |  30 |         1.000 |       0.000 |       0.000 |   0.000 |              0.000 |    0.1 |    0.1 |    0.1 |
| det-persona | fr   |  30 |         1.000 |       0.000 |       0.000 |   0.000 |              0.000 |    0.1 |    0.1 |    0.1 |
| jev-central | en   |  30 |         0.733 |       0.267 |       0.000 |   0.000 |              0.000 |  225.0 |  326.8 |  474.7 |
| jev-central | fr   |  30 |         0.733 |       0.267 |       0.000 |   0.000 |              0.000 |  238.6 |  319.8 |  356.2 |
| jev-persona | en   |  30 |         1.000 |       0.000 |       0.000 |   0.000 |              0.933 |  275.6 | 1704.2 | 1870.8 |
| jev-persona | fr   |  30 |         1.000 |       0.000 |       0.000 |   0.000 |              0.967 |  251.5 |  383.6 | 1100.8 |

## Verdicts

No non-baseline arm met the 0.20 MDE. Every candidate is **target_missed**.

| Arm         | Lang | Delta vs baseline | Verdict       |
| ----------- | ---- | ----------------: | ------------- |
| det-persona | en   |             0.000 | target_missed |
| det-persona | fr   |             0.000 | target_missed |
| jev-central | en   |            −0.267 | target_missed |
| jev-central | fr   |            −0.267 | target_missed |
| jev-persona | en   |             0.000 | target_missed |
| jev-persona | fr   |             0.000 | target_missed |

**No routing policy is adopted or selected by M3a.**

## Interpretation

- Deterministic central reaches 1.000 in both languages. The labels were produced
  independently by two blind agent passes, but the synthetic tasks were designed
  from the same persona/objective features the deterministic policy uses. This
  makes a positive deterministic improvement over that baseline effectively
  impossible and is a dataset limitation, not evidence that deterministic routing
  is generally perfect.
- Jev central produces more false speaks: 8/30 in each language. It never wrongly
  yields.
- Jev per-persona reaches the same accepted rate because it falls back to the
  deterministic per-persona policy on a Noul in the unsettled band: 93.3% EN and
  96.7% FR. This is evaluated as deployed, including fallback, not as a clean
  model-only arm.
- All per-language rows are reported separately. No composite score was used.
- No threshold was changed after holdout.

## Artifacts

- Exact restricted artifacts: `evals/results/m3a-routing-comparison/artifacts/`
- Full matrix and verdicts: `evals/results/m3a-routing-comparison/comparison.json`
- Durable copy: `evals/analysis/m3a-routing-comparison-2026-11-09.json`
