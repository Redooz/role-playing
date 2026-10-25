# Run index

`evals/results/` is git-ignored per run; this file is the curated index that is
committed. Add one row when a run is accepted, rejected or marked
inconclusive, and point at its directory. The directory itself can be deleted
or regenerated, but the row stays.

| Date | Run ID | Suite | Verdict | Notes |
| --- | --- | --- | --- | --- |
| 2026-10-25 | `m0-canned-replay` | canned replay determinism (G1) | accepted | 12 normalised traces, 2 runs byte-identical; baseline promoted |
| 2026-10-25 | `m0-harness-overhead` | harness overhead (G5) | recorded | no budget frozen at M0 |
| 2026-10-25 | `jev-canary-2026-10-25` | Jev integration canary (G4) | accepted (canary) | 3 live calls, $0.0000465 |
| 2026-10-25 | `soak-2026-10-25T17-55-13-434Z` | LiveKit soak (G6) | running | 10 × 20 min cycles |
