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
- **Name the purpose.** A capability eval proves new behaviour; a regression eval protects existing behaviour. One does not substitute for the other.

## M0 gates

M0 is scaffolding, so these gates are about reproducibility and workflow
integrity, not product quality. They are the first entries in this log.

| Date       | Gate                                      | Run ID                          | Verdict           | Evidence                                                                                                                                                                                                                                                           |
| ---------- | ----------------------------------------- | ------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-25 | G1 canned replay determinism (regression) | `m0-canned-replay`              | accepted          | 2 full CLI runs, 12 trials -> 12 normalised transcripts (6 EN + 6 FR tasks, 2 rounds, both splits) byte-identical; manifest sha256 `5fae6984…5c2f`; only wall-clock metadata differs                                                                               |
| 2026-10-25 | G2 manifest enforcement                   | `m0-canned-replay`              | accepted          | 10 required manifest sections, each deleted in turn: explicit `"<section>: missing required field"`, exit 2, nothing executed, no results directory created                                                                                                        |
| 2026-10-25 | G3 task validator                         | `validate-tasks`                | accepted          | 0 violations on the committed tree; `SPLIT_LEAKAGE`, `MISSING_PROVENANCE`, `LANG_PATH_MISMATCH`, `DUPLICATE_ID`, `GOLDEN_AGREEMENT_MISSING`, `GOLDEN_TASK_MISSING`, `GOLDEN_TASK_SPLIT_MISMATCH` all covered by tests; CI job `task validator (G3)` green on PR #1 |
| 2026-10-25 | G4 Jev integration canary                 | `jev-canary-2026-10-25`         | accepted (canary) | 3 pre-registered questions; EN yes 0.98, FR yes 0.99, unsettled yes 0.67 (strictly between 0 and 1); served snapshot `typesafe/jev-1.14-20261014`; cost $0.0000465                                                                                                 |
| 2026-10-25 | G5 agent-harness overhead                 | `m0-harness-overhead`           | recorded          | p99: dispatch 209 µs, serialization 13.6 µs, append 2.9 µs (500 iterations, Node 26.7.0); `evals/results/m0-harness-overhead/bench.json`; no budget frozen                                                                                                         |
| 2026-10-25 | G6 LiveKit soak                           | `soak-2026-10-25T17-55-13-434Z` | accepted          | 10/10 cycles × 20 min, 1,199,607 frames received, 0 crashes, 0 reconnects, handles 0→0, dispose 4–6 ms; RSS +70.3 MB over 200 min with flat JS heap (18.8→18.4 MB) and inter-cycle step growth noted                                                               |

## M0.1 review layer

The self-hosted Langfuse instance observes runs; it does not decide them. These
gates cover the exporter and the review workflow, not application behaviour.

| Date       | Gate                   | Run ID             | Verdict  | Evidence                                                                                                                                                                                     |
| ---------- | ---------------------- | ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-07 | L1 stack health        | `langfuse`         | accepted | Langfuse 4.76.0 on the Mac mini Docker host; Postgres, ClickHouse, Redis, MinIO healthy; UI on loopback; headless init created org, project, user and keys; no secrets committed             |
| 2026-11-07 | L2 mapping purity      | unit suite         | accepted | 331 unit tests; deterministic mapper, `grades.jsonl`, no network; `npm run typecheck`, lint and format clean                                                                                 |
| 2026-11-07 | L3 export completeness | `m0-canned-replay` | accepted | 12 item traces; 12 × (5 turn spans, 3 generations, 7 events, 8 scores); `langfuse.json` maps every item to its trace id; experiment `m0-canned-replay-20261107T212616Z-e8958f18`             |
| 2026-11-07 | L4 failure semantics   | unit + CLI suite   | accepted | Export failure leaves the verdict accepted and writes `langfuse.json` with `status: failed`; `--require-export` exits 3 after artifacts; provider outage grades as `inconclusive`, never `0` |
| 2026-11-07 | L5 review workflow     | two exports        | accepted | `m0-canned-replay-20261107T212616Z-e8958f18` and `...212620Z-02e7056d` expose the same 12 item ids; scores filter by `trial.status`; metadata carries lang, task id, CEFR band and split     |
| 2026-11-07 | L6 privacy             | `langfuse`         | accepted | Self-hosted only; the exporter refuses `langfuse.com`; server `.env` stays on the Docker host; traces carry only service/scope metadata, no host, PID or command line; no raw audio          |

## Accepted and rejected changes

| Date | Change | Run ID | Verdict | Notes                               |
| ---- | ------ | ------ | ------- | ----------------------------------- |
| —    | —      | —      | —       | no behaviour changes exist yet (M0) |
