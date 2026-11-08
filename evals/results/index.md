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
| 2026-11-07 | `m0-canned-replay` (M0.1 export) | canned replay determinism (G1) | regression | code | accepted | 12 trials; `grades.jsonl` and `langfuse.json`; 12 traces × (5 turn spans, 3 generations, 7 events, 8 scores); experiment `m0-canned-replay-20261107T212616Z-e8958f18`; comparison `m0-canned-replay-20261107T212620Z-02e7056d` |
| 2026-11-07 | `m1-text-latency` | text latency baseline (M1-G4) | capability | code (wall-clock bench) | accepted (baseline) | 100 live Groq turns (20 × 5), 0 failures, 3 s pacing; TTFT p50/p95/p99 371/594/748 ms; no budget frozen; text proxy only |
| 2026-11-07 | `m1-text-latency-probe-google-gemma-4-31b-it` | OpenRouter `google/gemma-4-31b-it` latency probe | capability | code (wall-clock bench) | recorded (probe) | 100 live turns, 0 failures; TTFT p50/p95/p99 635/2123/3944 ms; not the product model |
| 2026-11-07 | `m1-text-latency-probe-openai-gpt-oss-120b` | OpenRouter `openai/gpt-oss-120b` latency probe | capability | code (wall-clock bench) | recorded (probe) | 100 live turns, 0 failures; TTFT p50/p95/p99 1465/2895/5675 ms; not the product model |

Langfuse experiment links are local to the self-hosted instance:
`http://127.0.0.1:3000/project/8cdf72afddb90bd4e129b3c7/experiments/results?baseline=<execution-id>`.
Open the tunnel with `npm run langfuse:tunnel` first. The link only works on this
machine; the run directories keep the raw evidence:
`evals/results/m0-canned-replay/` and
`evals/results/m01-comparison/m0-canned-replay/`.
