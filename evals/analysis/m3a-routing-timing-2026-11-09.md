# M3a routing timing spike — 2026-11-09

Scope: calibration-only synthetic routing tasks, uncached Jev calls, complete
policy decision from start to outcome. No holdout task was used.

Command:

```sh
RUN_M3A_TIMING=1 npm run test:bench -- tools/routing-bench/src/routing-timing.bench.spec.ts
```

Sample: 3 English + 3 French calibration tasks, each run through central selection
and per-persona requests = 12 complete decisions. Live spend: **$0.00085**,
inside the $5 cap. No failures.

## Latest run

| Topology    | Lang |   n | p50 ms | p95 ms | p99 ms | max ms | Timeout fallbacks | Unsettled fallbacks |
| ----------- | ---- | --: | -----: | -----: | -----: | -----: | ----------------: | ------------------: |
| central     | en   |   3 |  234.4 |  424.8 |  441.8 |  446.0 |                 0 |                   0 |
| central     | fr   |   3 |  214.5 |  216.7 |  216.9 |  216.9 |                 0 |                   0 |
| per-persona | en   |   3 | 1125.0 | 1125.5 | 1125.5 | 1125.6 |                 0 |                   3 |
| per-persona | fr   |   3 | 1122.8 | 1410.4 | 1435.9 | 1442.3 |                 0 |                   3 |

An earlier run of the same spike observed one central decision at 2,315 ms, so the
tail is variable. The frozen bound covers the larger observed tail.

## Frozen decision

**Complete-decision deadline: 2,500 ms.** It is frozen before the holdout run and
is not selected from holdout results. The architecture's initial 100–150 ms
probe is rejected as unrealistic for the pinned Jev model on this workload.

## Finding: per-persona arm falls back on unsettled judgments

All six per-persona samples used the declared deterministic fallback. The cause
was **unsettled Noul judgments**, not timeouts: zero timeout fallbacks were
observed. The per-persona model arm is therefore evaluated in D6 exactly as it
would deploy: its decision quality is the deterministic per-persona result,
while its latency and fallback rate remain its own. This is a real finding, not
a reason to widen thresholds after seeing holdout results.

No threshold tuning is performed in M3a. The 0.7 / 0.3 bands stay frozen.

## Caveat

This is a small calibration timing sample. P99 is descriptive, not a stable
population estimate. D6 reports holdout latency and fallback rates for every arm.
