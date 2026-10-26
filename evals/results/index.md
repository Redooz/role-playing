# Run index

`evals/results/` is git-ignored per run; this file is the curated index that is
committed. Add one row when a run is accepted, rejected or marked
inconclusive, and point at its directory. The directory itself can be deleted
or regenerated, but the row stays.

**Purpose** is `capability` (what can the agent do well?) or `regression` (does
it still handle every task it used to?). **Grader** is `code`,
`system-one-model`, or `human`; a compatibility probe with no grader says `—`.

| Date | Run ID | Suite | Purpose | Grader | Verdict | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-25 | `m0-canned-replay` | canned replay determinism (G1) | regression | code | accepted | 12 trials, 12 normalised transcripts; 2 runs byte-identical; baseline promoted |
| 2026-10-25 | `m0-harness-overhead` | agent-harness overhead (G5) | capability | code | recorded | no budget frozen at M0 |
| 2026-10-25 | `jev-canary-2026-10-25` | Jev integration canary (G4) | capability | system-one-model | accepted (canary) | 3 live calls, $0.0000465 |
| 2026-10-25 | `soak-2026-10-25T17-55-13-434Z` | LiveKit soak (G6) | capability | — | accepted | 10 × 20 min cycles, 0 crashes, 0 handle growth, RSS +70.3 MB noted |
