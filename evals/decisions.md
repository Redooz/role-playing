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

Analysis notes referenced below moved to Notion on 2026-11-15 and are no longer
committed. `evals/analysis/` is git-ignored; path references in older rows are
historical.

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

## M1 gates

M1 measures the text path before audio exists. The latency row is a baseline,
not a budget: the numbers are recorded and the proxy is labelled.

| Date       | Gate                              | Run ID             | Verdict             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | --------------------------------- | ------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-08 | M1-G1 deterministic replay        | `m0-canned-replay` | accepted            | 12 trials × 2 rounds, two runs byte-identical at transcript schema 1.3.0; replay emits the same event vocabulary as the driver (no replay-only `turn.revoked`; empty chunks skipped); a full driver session with the canned adapter also replays byte-identically; baseline re-promoted at codeSha `97512cf`.                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-11-07 | M1-G2 cancellation properties     | unit suite         | accepted            | Fuzzed before every chunk boundary and across 60 seeded interleavings of chunk/interrupt/close: no chunk after a terminal event, one terminal per turn, sequences start at 0 and increase, partial text preserved, next turn succeeds, duplicate interrupt/close is a no-op; §3.2 guard clean.                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-11-07 | M1-G3 persistence and replay      | unit suite         | accepted            | Log round-trip reproduces the normalized transcript; a truncated final line is dropped and reported with no fabricated completion; unknown major version rejected; content-class guard enforced at parse; replay is model-free.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-11-07 | M1-G4 text latency baseline       | `m1-text-latency`  | accepted (baseline) | 100 live Groq turns (20 sessions × 5, `openai/gpt-oss-20b`, 3 s pacing, 0 failures). Turn utterance→first chunk (TTFT): p50 371 / p95 594 / p99 748 ms (n=100). Utterance→committed: p50 373 / p95 618 / p99 765 ms. Session start→first text chunk (text proxy only): p50 377 / p95 494 / p99 517 ms (n=20). Provider request→first content: p50 371 / p95 594 / p99 748 ms. Local overhead (driver + event loop): p50 0.1 / p99 0.4 ms. **No budget frozen**; `evals/results/m1-text-latency/latency.json`.                                                                                                                                                                                  |
| 2026-11-08 | M1-G5 trial isolation             | unit suite         | accepted            | Interleaved trials: distinct clock/RNG/provider instances, dispose on success, failure and timeout, environment restore, timer and local-socket teardown, no unhandled rejection; 12/12 providers disposed; the timeout aborts the replay signal and waits a bounded grace window for the work to stop; a trial that does not stop is an infrastructure failure; cleanup is bounded and dispose is idempotent; a timed-out trial is never a quality "no". The docstring states the remaining isolation gaps from AGENTS.md.                                                                                                                                                                    |
| 2026-11-08 | M1-G6 mutation baseline and floor | `npm run mutation` | accepted            | StrykerJS 10.1.1 over the M1 packages: global 79.21% total / 82.40% covered (1086 killed, 19 timeout, 236 survived, 54 no coverage, 17 invalid-schema runtime errors excluded). Per package: `session-core` 84.67/85.79, `pipeline` 70.75/74.90, `apps/cli` 66.22/75.77. Cancellation invariants: **0 meaningful survivors** (40 documented equivalents). Floor frozen at the measured values; `stryker.triage.md`, `evals/baselines/m1-mutation.json`. Re-measured after the round-2 review fixes (version-first parse, log contiguity, bounded trial stop grace, provider-failure detail, request-id timing, writer death, mutation-report validation); the floor was raised, never lowered. |

## M1 probes

Comparison runs do not change the product model or the M1 baseline.

| Date       | Probe                              | Run ID                                        | Verdict          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ---------------------------------- | --------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-07 | OpenRouter `google/gemma-4-31b-it` | `m1-text-latency-probe-google-gemma-4-31b-it` | recorded (probe) | 100 live turns (20 × 5, 3 s pacing, 0 failures). TTFT p50 635 / p95 2123 / p99 3944 ms (max 12124). Total p50 657 / p95 2379 / p99 3968 ms. Session start→first text chunk (text proxy): p50 517 / p95 1913 / p99 2032 ms (n=20). Provider time ~same as the driver; local overhead p99 0.2 ms. Groq baseline for comparison: TTFT p50 371 / p95 594 / p99 748 ms. Product persona model unchanged (`openai/gpt-oss-20b`). `evals/results/m1-text-latency-probe-google-gemma-4-31b-it/latency.json`. |
| 2026-11-07 | OpenRouter `openai/gpt-oss-120b`   | `m1-text-latency-probe-openai-gpt-oss-120b`   | recorded (probe) | 100 live turns (20 × 5, 3 s pacing, 0 failures). TTFT p50 1465 / p95 2895 / p99 5675 ms (max 6763). Total p50 1496 / p95 2906 / p99 5817 ms. Session start→first text chunk (text proxy): p50 1306 / p95 5719 / p99 6554 ms (n=20). Provider time ~same as the driver; local overhead p99 0.2 ms. Product persona model unchanged (`openai/gpt-oss-20b`). `evals/results/m1-text-latency-probe-openai-gpt-oss-120b/latency.json`.                                                                    |

## M2 implementation

M2 adds personas, scenarios, locales and a live session path. The live capability
and locale probes need Groq and OpenRouter keys, so their rows stay `pending`
until the run ids exist. A pending row is not acceptance.

| Date       | Gate                        | Run ID                                        | Verdict                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | --------------------------- | --------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-08 | M2-G1 persona/scenario data | unit + `validate-tasks`                       | accepted                                       | Three personas and three scenarios with `en`/`fr`/`en-GB`/`fr-CA` variants validate; 12 session tasks plus the 6 M1 replay tasks validate with 0 violations; missing locale and mismatched base language are hard errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-11-08 | M2-G2 prompt contract       | unit suite                                    | accepted                                       | Deterministic prompt hash; greeting pack A is byte-identical without pack B; locale in the prompt and hash; `en-UK` rejected; plain-text filter is idempotent, chunk-boundary independent and tested against Markdown, emoji, false positives and empty output.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-11-08 | M2-G3 greeting + runner     | `m2-persona-replay`                           | accepted                                       | 12 trials (6 tasks × 2 rounds) drove the real driver with greeting-first turns and four scripted learner turns; canned replay was byte-identical; the plain-text hook and `response.plain_text` invariant held.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-11-08 | M2-G5 regression            | `m0-canned-replay`, `m2-persona-replay`       | accepted                                       | M1 replay still passes unchanged; M2 canned session replay is deterministic; the task validator is clean; the M1 mutation floor is not lowered (see M2-G7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-11-08 | M2-G6 locale variants       | `m2-locale-baseline` + unit                   | provisional                                    | Locale selection, prompt copy and no-fallback behaviour are covered, and locale-specific Jev questions enter the cache key. The generic locale baseline completed 18/18 trials with 0 failures: `locale.fit` 0.674, consistency 0.542, language quality 0.932, register 0.764, clarity 0.869, objective 0.803; `pass^1` 0.611 / `pass^3` 0.5. The pinned-model locale probe is blocked by the same TPD cap. The OpenRouter safeguard locale probe was run and **rejected**: locale fit improved only 0.028 (MDE 0.1) and clarity regressed 0.111 (tolerance 0.05). The pinned-model variants remain provisional.                                                                                                                                                                                                                                                                                                          |
| 2026-11-08 | M2-G4 base capability eval  | `m2-persona-baseline`, `m2-persona-scenarios` | infrastructure-inconclusive                    | The generic baseline completed 30/30 trials with 0 failures: persona consistency 0.518, language quality 0.943, register 0.799, clarity 0.837, objective 0.758; `pass^1` 0.567 / `pass^3` 0.267. The persona candidate hit Groq HTTP 429 on 22/30 trials, so only 8 completed. On those 8, persona consistency was 0.815, register 0.918, objective 0.874, clarity 0.845 and language quality 0.923 (within the 0.05 tolerance). The direction is positive but the run is not acceptance evidence. A second attempt at 10.5 s pacing (about 6 calls/min, measured 645-token prompt) still failed: Groq returned 429 on 29/30 trials. A direct probe showed the binding limit is the organization TPD (200,000 tokens; 199,632 used), not TPM. The pinned-model gate is blocked until the rolling token budget frees. The separate OpenRouter safeguard probe (different model) was accepted; see **M2 OpenRouter probe**. |
| 2026-11-08 | M2-G7 mutation floor        | `npm run mutation`                            | accepted (existing floors); extended-scope gap | Global 80.14% total / 83.20% covered; `session-core` 85.77/86.85, `pipeline` 74.01/77.66, `apps/cli` 66.96/76.38. Every existing floor held and was not lowered. The pipeline plain-text and LiveKit Inference adapters are newly in scope; `persona-kit`, `scenario-kit`, `shared/plain-text`, `shared/locale` and `apps/cli/main.ts` remain outside the floor until their tests can hold the global bar. Recorded in `stryker.triage.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## M2 OpenRouter probe

The Groq organization budget (200k TPD) blocked the pinned-model live runs. While
waiting for a Developer account, the same persona path was measured through
OpenRouter's `openai/gpt-oss-safeguard-20b`. OpenRouter lists exactly one endpoint
for that model, and it is Groq. **This is a different model artifact**: it is a
probe, not M2-G4/G6 acceptance, and it does not change the fixed product model.

| Date       | Run                       | Verdict                   | Evidence                                                                                                                                                                                                    |
| ---------- | ------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-08 | `m2-persona-baseline-or`  | accepted (probe baseline) | 30/30 trials, 0 failures; consistency 0.550, language quality 0.931, register 0.791, clarity 0.841, objective 0.760; `pass^1` 0.633 / `pass^3` 0.317.                                                       |
| 2026-11-08 | `m2-persona-scenarios-or` | accepted (probe)          | 30/30 trials, 0 failures; consistency **0.804** vs 0.550, register **0.907** vs 0.791, objective **0.858** vs 0.760, clarity 0.794 vs 0.841 (within 0.05), language 0.930; `pass^1` 0.967 / `pass^3` 0.900. |
| 2026-11-08 | `m2-locale-baseline-or`   | accepted (probe baseline) | 18/18 trials, 0 failures; locale fit 0.707, consistency 0.616, language quality 0.933, register 0.818, clarity 0.879, objective 0.802.                                                                      |
| 2026-11-08 | `m2-locale-variants-or`   | rejected (probe)          | 18/18 trials, 0 failures; locale fit **0.734** vs 0.707 (+0.028, below the 0.1 MDE); clarity **0.768** vs 0.879 (−0.111, over the 0.05 tolerance).                                                          |

OpenRouter's upstream 429s are transient ("temporarily rate-limited upstream").
The live provider now retries a 429 only when no text has been yielded, with a
bounded backoff; a mid-stream failure is never replayed. The OpenRouter profile
omits `reasoning_effort`/`include_reasoning` because they route Groq to the
`flex` tier; the token cap is 2048 to leave room for reasoning before the reply.

## M2 LiveKit Gemma probe

A second probe path uses LiveKit Inference's hosted `google/gemma-4-31b-it`.
LiveKit exposes an OpenAI-compatible gateway authenticated with a short-lived
JWT minted from `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`. **This is again a
different model artifact**: it is a probe, not M2-G4/G6 acceptance, and it does
not change the fixed product model.

The Gemma run uses a separate prompt family. It drops the OpenAI-specific
Harmony header and `analysis`/`commentary`/`final` channel vocabulary, writes
the instructions as a direct first-turn preamble (Google's Gemma 3 guidance),
and uses plain-text section labels plus short examples. It is versioned
`m2-prompt-gemma-v1` and hashed like the Harmony prompt.

| Date       | Run                       | Verdict                   | Evidence                                                                                                                                                                                                               |
| ---------- | ------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-08 | `m2-persona-baseline-lk`  | accepted (probe baseline) | 30/30 trials, 0 failures; consistency 0.296, language quality 0.840, register 0.707, clarity 0.887, objective 0.748; `pass^1` 0.133 / `pass^3` 0.000.                                                                  |
| 2026-11-08 | `m2-persona-scenarios-lk` | accepted (probe)          | 30/30 trials, 0 failures; consistency **0.878** vs 0.296, language quality **0.950** vs 0.840, register **0.899** vs 0.707, clarity **0.907** vs 0.887, objective **0.867** vs 0.748; `pass^1` 1.000 / `pass^3` 1.000. |

The LiveKit adapter mints an inference-grant JWT per request. Provider base URLs
are optional `.env` overrides (`GROQ_BASE_URL`, `OPENROUTER_BASE_URL`,
`LIVEKIT_INFERENCE_URL`); the defaults stay in the adapters.

## M2 model default: LiveKit Gemma

On 2026-11-09 the default persona model moved from Groq
`openai/gpt-oss-20b` to LiveKit Inference `google/gemma-4-31b-it` with the
`gemma` prompt family. The chat CLI and the `-lk` eval manifests now use it; the
canned session regression also replays the Gemma prompt. The Groq manifests and
results remain as the historical pinned path, and the OpenRouter safeguard path
is retired.

Evidence: `m2-persona-scenarios-lk` accepted with 30/30 trials, consistency
**0.878** vs a 0.296 generic baseline, `pass^1`/`pass^3` 1.000/1.000; the
LiveKit latency probe measured TTFT p50/p95/p99 205/295/552 ms with 100/100
turns and no failures. The semantic gate is **provisional** until the human
agreement pass in `m2-persona-rubric-v1` is complete.

Both runs were re-exported to the self-hosted Langfuse on 2026-11-09. The
annotation queues `M2 Gemma labels — en` and `M2 Gemma labels — fr` each hold
30 traces (15 candidate + 15 baseline), with numeric 1–5 score configs for the
five base axes.

## M2 annotation review, threshold and French grader

On 2026-11-09 the M2 annotation queues were filled with two independent,
context-free agent passes: 30 English + 30 French traces each (15 candidate
`m2-persona-scenarios-lk`, 15 baseline `m2-persona-baseline-lk`). All 60 queue
items are `COMPLETED`; the two original human traces were kept and re-scored by
the second pass. This is **agent labelling**, not human agreement.

Agreement between the two passes: `persona.consistency` 83% exact / QWK 0.85,
`language.quality` 100%, `register.fit` 90%, `objective.completion` 64% / QWK
0.74. The second pass was consistently more generous.

The review found the 0.50 Jev line too permissive: it accepted 100% of baseline
task-help traces, while the passes accepted roughly half to two-thirds. A single
**0.75** line matched the held-out rounds (0–2 tune, 3–4 check) and kept candidate
scores high. `M2_JEV_THRESHOLD` is now 0.75 for the whole M2 grader (all axes,
`en`/`fr`, locale probe). There are no per-axis thresholds: the decision-model
notes require one frozen line per grader version, and 30–58 labels per axis are
too few to tune five lines separately.

Rubric v2 (`m2-persona-rubric-v2`, `m2-annotation-guideline-v2`) adds explicit
French criteria: accents and hyphens for `language.quality`; a consistent
`tu`/`vous` choice for `register.fit`. The new manifests
`m2-persona-scenarios-lk-v2` and `m2-persona-baseline-lk-v2` carry v2.

| Date       | Gate                              | Run ID                                                      | Verdict                              | Evidence                                                                                                                                                                                                                                                                                                     |
| ---------- | --------------------------------- | ----------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-09 | M2 annotation review              | `annotation-kit-m2`                                         | accepted (agent labels, provisional) | 60/60 traces, two passes; threshold evidence recorded in `evals/analysis/m2-annotation-review-2026-11-09.md`; human pass still required.                                                                                                                                                                     |
| 2026-11-09 | M2-G4 base capability (rubric v2) | `m2-persona-scenarios-lk-v2` vs `m2-persona-baseline-lk-v2` | accepted (provisional semantic gate) | 30/30 trials, 0 failures each. Candidate vs baseline: persona 0.875 vs 0.280, language 0.944 vs 0.742, register 0.839 vs 0.679, clarity 0.895 vs 0.881, objective 0.860 vs 0.752; `pass^1` 0.700 / `pass^3` 0.533 vs 0/0. All guardrails and invariants pass. Gate provisional: labels are agent, not human. |
| 2026-11-09 | M2-G4 post-M2 fixes               | `m2-persona-scenarios-lk-v4` vs `m2-persona-baseline-lk-v3` | accepted (provisional semantic gate) | 30/30 trials, 0 failures. Candidate persona 0.888 vs baseline 0.347; language 0.941 vs 0.817; register 0.917 vs 0.736; clarity 0.925 vs 0.902; objective 0.903 vs 0.848; `pass^1` **1.000** / `pass^3` **1.000** vs 0/0. All six tasks 5/5.                                                                  |

### Post-M2 quality fixes (2026-11-09)

Four targeted fixes were applied after the v2 acceptance:

- the French peer greeting and boundary now require `tu` for `fr`/`fr-CA`;
- the decline scenario had the learner and client turns inverted in all four
  locale tasks; the learner now declines and offers the alternative, and the
  client raises the request and resists;
- the client persona now has an explicit boundary that it is the client, not the
  account manager;
- `objective.completion` now says to judge the persona’s contribution, not the
  learner’s success, and not to let the persona do the learner’s task.

The v3 baseline (generic prompt on the fixed tasks) still failed every trial
(`pass^1` 0). The v4 candidate passed all six tasks, 5/5 each:

| Axis                   | v4 candidate | v3 baseline |
| ---------------------- | ------------ | ----------- |
| `persona.consistency`  | 0.888        | 0.347       |
| `language.quality`     | 0.941        | 0.817       |
| `register.fit`         | 0.917        | 0.736       |
| `response.clarity`     | 0.925        | 0.902       |
| `objective.completion` | 0.903        | 0.848       |
| `pass^1`               | **1.000**    | 0           |
| `pass^3`               | **1.000**    | 0           |

All guardrails and invariants pass. `m2-persona-scenarios-lk-v4` is the final M2
capability run; v2 and v3 are superseded. The v4 candidate uses the
`m2-persona-baseline-lk-v3` baseline.

Mutation floor: the scope now includes the behaviour-bearing `persona-kit` prompt
and lookup, `scenario-kit` lookup/helper, `shared/locale`, `shared/plain-text`
and `apps/cli/main.ts`; static data/schema files are excluded because mutating
them produces compile errors. On 2026-11-09 the suite was raised from global
68.21/72.74 to **95.01/95.42**, with per-package floors in
`evals/baselines/m1-mutation.json`. `apps/cli` rose to **95.95/97.13**,
`persona-kit` to **99.10/99.40**, `pipeline` to **99.01/99.01** and
`scenario-kit` to **100.00/100.00**. Two packages remain below 95:
`session-core` **91.96/92.24** and `shared` **93.27/93.57**. Their remaining
survivors are either Zod schema/static vocabulary mutants, which this task
explicitly excludes, or documented equivalent mutants; see `stryker.triage.md`
for the line-by-line inventory and the smallest next step. No floor was lowered:
the recorded floors are the new measured values and the Stryker break threshold
was raised from 68.21 to 95.

M2 is closed with the semantic gate **provisional by project choice**. The project
uses agent annotation for now; no human pass is planned. “Provisional” means the
gate is accepted on agent labels and is not based on human labels. It is a status,
not a blocked task. It can become `stable` only if a human pass is added later.
The v4 run removed the earlier weak tasks: all six tasks are 5/5.

### French grader decision

Jev remains the M2 grader. The French questions now carry the accents/hyphens and
`tu`/`vous` criteria, but Jev's French `register.fit` ranking is weak (AUC about
0.48–0.62); a threshold change will not fix that.

Research suggested **Mistral Large 4** as the first candidate because it was
listed with token `logprobs`. The 2026-11-09 spike found that OpenRouter rejects
`logprobs` for that model (“Logprobs are not enabled for this model”) and forces
reasoning, so a one-token probability is not available. The practical test used
**Mistral Large 3** (`mistralai/mistral-large-2512`) on the 30 French traces.

Jev v2 was better on persona (balanced accuracy 1.000 vs 0.542), language
(0.800 vs 0.650) and register (0.925 vs 0.250; Mistral’s register was inverted).
Objective was mixed (Mistral binary 0.917 vs 0.861; Jev AUC 0.944 vs 0.917).
No grader switch in M2. See
`evals/analysis/m2-french-grader-spike-2026-11-09.md`. If a second grader is still
wanted later, test Mistral Large 4 with a proper reasoning budget and a human
audit, or a strong multilingual model with a calibrated verbalised probability.

## Post-review harness and French register fixes (2026-11-09)

Three review findings on PR #6 were accepted and fixed:

- **Rubric honesty.** A semantic grader now declares the rubric it can ask
  (`Grader.rubricVersion`), and `assertGraderMatchesManifest` rejects a manifest
  whose `rubric.version` the grader does not implement. The Jev grader asks
  `m2-persona-rubric-v2` only. Manifest v1 runs are historical and now fail fast;
  they are not edited. The documented default commands point at the accepted v2
  manifests.
- **French register.** The shared `fr`/`fr-CA` conventions no longer contain the
  unconditional “Vouvoyez” line. The register now follows
  `persona.voice.formality`: `tu` for the informal peer, `vous` for the formal
  manager and client. Both prompt packs render exactly one register rule. The
  prompt templates move to `m2-prompt-v2` and `m2-prompt-gemma-v2`.
- **Canned prompt mode.** `buildSessionCannedEntries` now receives the manifest's
  prompt mode, so a canned `generic` manifest matches its recordings instead of
  silently using the persona prompt.
- **Generic prompt version.** `assertSessionPrompt` compares a `generic`
  manifest with `m2-generic-baseline-v1` instead of the Harmony template version.

New pre-registered manifests: `m2-persona-replay-v2` (canned, prompt gemma v2),
`m2-persona-fr-register-v1` (French-only probe, 3 tasks × 5 rounds),
`m2-persona-scenarios-lk-v5` (full capability) and
`m2-persona-baseline-lk-v4` (generic, corrected version). The accepted v4/v3
records stay unchanged.

Results:

- `m2-persona-replay-v2` accepted and promoted to
  `evals/baselines/m2-persona-replay.json` after a re-run on merge commit
  `05b986a`: 12 trials, byte-identical transcripts, all invariants and guardrails
  pass at prompt gemma v2.
- `m2-persona-scenarios-lk-v5` accepted and promoted to
  `evals/baselines/m2-persona-scenarios.json` after a re-run on merge commit
  `05b986a`: 30/30 trials, 0 failures, against the `m2-persona-baseline-lk-v3`
  baseline. Candidate vs baseline: `persona.consistency` 0.882 vs 0.347,
  `language.quality` 0.944 vs 0.817, `register.fit` 0.917 vs 0.736,
  `response.clarity` 0.926 vs 0.902, `objective.completion` 0.921 vs 0.848;
  `pass^1` 0.967 / `pass^3` 0.900. All guardrails and invariants pass. Five of
  six tasks are 5/5; the French client task is 4/5. The earlier run of the same
  manifest was produced before the fix commit (`codeSha` `e7e492c`) and is not
  promoted.
- `m2-persona-fr-register-v1` **rejected**: 15/15 trials completed with 0
  failures, and French `register.fit` held at 0.932 vs the v4 French subset
  0.931. The run failed its own `persona.consistency` target: 0.844 vs 0.861.
  The drop is concentrated on the French client task, where near-identical
  client text scored 0.78 in v4 and 0.61 in this run. This is Jev variance on a
  borderline task, not a prompt effect. The probe is kept as a rejected record
  and is not a gate; the full v5 run is the accepted gate.

The French change is still **regression**, not a capability claim: the accepted
v4 peer already used `tu` in all five rounds, and Jev's French `register.fit`
ranking is weak. The deterministic prompt tests are the proof that the
contradiction is gone.

## M3a implementation

| Date       | Gate                                      | Run ID                                                         | Verdict                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ----------------------------------------- | -------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-09 | M3a-G1 routing contracts                  | `unit suite` / PR #8                                           | accepted                            | Routing contracts, deterministic truth tables, append-only decision assembly and seeded ranking pass 121 focused tests; `packages/routing-policy` mutation is 100%. No labels enter policy state.                                                                                                                                                                                                                                                                                                              |
| 2026-11-09 | M3a-G2 labelled dataset                   | `m3a-routing-annotation`                                       | accepted (provisional agent labels) | 120 tasks (60 EN + 60 FR; 30 calibration + 30 holdout per language), all linked to golden labels; two independent blind agent passes after the opaque-id fix agree 120/120, 60/60 per language; labels stay `draft`, source `agent`.                                                                                                                                                                                                                                                                           |
| 2026-11-09 | M3a-G3 exact replay and failure semantics | `routing runner suite` / PR #12                                | accepted                            | Exact restricted artifacts preserve context hash, payload, raw response, distributions, usage, outcome and fallback provenance. Timeout uses same-topology deterministic fallback for audit but the artifact is `infrastructure_incomplete` and excluded from accepted-outcome quality; transport/schema failures are also incomplete; artifacts append.                                                                                                                                                       |
| 2026-11-09 | M3a-G4 routing timing                     | `m3a-routing-timing`                                           | accepted (recorded)                 | 12 calibration-only uncached decisions (3 EN + 3 FR × central + per-persona), 0 failures, spend $0.00085. Central p50 266–568 ms; per-persona p50 268–1027 ms; max observed across runs 2,315 ms. Zero timeouts at the frozen 2,500 ms complete-decision deadline. This is an explicit deadline relaxation from the architecture's 100–150 ms starter bound; Noul thresholds stay 0.7/0.3. All six per-persona samples used the deterministic fallback because a Noul was unsettled, not because of a timeout. |
| 2026-11-09 | M3a-G6 regression and mutation            | `m0-canned-replay`, `m2-persona-replay-v2`, `npm run mutation` | accepted                            | Both canned regressions accepted with 12/12 trials, 0 failures and byte-identical replay; task validator 0 violations; mutation global 95.60/95.97, routing-policy 100.00/100.00; no existing floor lowered.                                                                                                                                                                                                                                                                                                   |
| 2026-11-09 | M3a-G5 routing comparison                 | `m3a-routing-comparison`                                       | complete (no policy adopted)        | 4 arms × 60 holdout tasks (30 EN + 30 FR), 240 decisions, 0 incomplete, $0.0085. `det-central` baseline 1.000 both languages. `det-persona` 1.000/1.000 (delta 0); `jev-central` 0.733/0.733 (delta −0.267, false speak 0.267); `jev-persona` 1.000/1.000 with 93.3%/96.7% deterministic unsettled fallback. No non-baseline arm met the 0.20 MDE, so no arm is adopted and no winner is selected. The deterministic ceiling is partly a dataset limitation: tasks were designed from the same feature rules.  |

## Accepted and rejected changes

| Date | Change | Run ID | Verdict | Notes                               |
| ---- | ------ | ------ | ------- | ----------------------------------- |
| —    | —      | —      | —       | no behaviour changes exist yet (M0) |

## M3b implementation

| Date       | Gate                                | Run ID                   | Verdict                    | Evidence                                                                                                                                                                                                                                                   |
| ---------- | ----------------------------------- | ------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-11 | M3b D5 speaker-label agreement      | `m3b-d5-label-agreement` | provisional (below target) | 24 `standup-scope-change` tasks, 4 user turns each, two independent agent passes: 36/48 exact English and 36/48 exact French (0.750), below the pre-registered 0.80. A third pass adjudicated all 24 disagreements; labels stay `draft` / `agent`.         |
| 2026-11-11 | M3b D5 multi-persona CLI and runner | `npm run test:unit`      | accepted (implementation)  | `npm run chat -- --provider canned --personas manager,peer --scenario standup-scope-change` prints `[manager]` and `[peer]` labels and writes one log with `personaIds`; the live runner records 6 shadow records for 2 user turns with an injected judge. |

The label row is a finding, not acceptance of the 0.80 target. D6 must carry it
with the capability run and must not call the agent labels stable.

| 2026-11-12 | M3b D6 timing and budgets | `m3b-timing` | accepted (recorded) | 500 reducer iterations per transition, no provider call; grant p95 0.060 ms, interject p95 0.014 ms, 32 partials p95 0.081 ms. Frozen config matches the plan defaults; capability uses 3 rounds, 6 holdout tasks per language, MDE 0.20, shadow deadline 2,500 ms, $5 cap. |
| 2026-11-12 | M3b capability — English | `m3b-det-persona-en-r3` vs `m3b-baseline-en-r3` | **rejected** | 18/18 trials each, 0 failures, invariants and `pass^3` 1.0. `turn_taking.acceptable_speaker_rate` 0.667 vs 0.750, delta −0.083, MDE 0.20. No policy adopted. |
| 2026-11-12 | M3b capability — French | `m3b-det-persona-fr-r3` vs `m3b-baseline-fr-r3` | **inconclusive** | 18/18 trials each, 0 failures, invariants and `pass^3` 1.0. Rate 0.667 vs 0.583, delta +0.083, below MDE 0.20. No policy adopted. |
| 2026-11-12 | M3b shadow comparison | `m3b-shadow` | recorded, no adoption | 144 records over 6 holdout tasks per language. Agreement: `jev-persona` 0.667, `det-central` 1.000, `jev-central` 0.625; total shadow cost $0.0056. Shadow records never changed a session event. |

| 2026-11-12 | M3b-G1 arbiter contract | `npm run test:unit`, `npm run mutation` | accepted | Pure reducer, structural ports, no clock/RNG/provider in the reducer; `turn-arbiter` 100/100 mutation. |
| 2026-11-12 | M3b-G2 invariants under fuzzing | `npm run test:unit` | accepted | Seeded 1,000-input fuzz suite plus seven targeted families; zero violations. |
| 2026-11-12 | M3b-G3 recovery matrix | `npm run test:unit` | accepted | All five recovery rows, bounded replacement and no grant spin. |
| 2026-11-12 | M3b-G4 live multi-persona session | `npm run test:unit`, `npm run chat -- --personas manager,peer` | accepted | One grant at a time, stale output dropped, §3.2 guard clean, `[manager]`/`[peer]` labels, single-persona replay byte-identical. |
| 2026-11-12 | M3b-G5 timing and budgets | `m3b-timing` | accepted | Reducer p95 grant 0.060 ms, interject 0.014 ms, 32 partials 0.081 ms; one frozen config and budget table. |
| 2026-11-12 | M3b-G6 capability and shadow evidence | `m3b-det-persona-en-r3`, `m3b-det-persona-fr-r3`, `m3b-shadow` | evidence complete; target not met | 18/18 trials per arm/language, zero incompletes; English rejected, French inconclusive; 144 shadow records and a summary. No adoption. |
| 2026-11-12 | M3b-G7 regression and mutation | `m0-canned-replay`, `m2-persona-replay-v2`, `npm run mutation` | accepted | Both canned replays accepted with deterministic rate 1; every mutation floor held. |
| 2026-11-12 | M3b close-out | `m3b-close-out-2026-11-12` | complete, no policy adopted | D1–D7 shipped; capability target missed; label agreement 0.75; eval-harness mutation and combined-spend metering recorded as gaps. |

## M3c implementation

| Date       | Gate                        | Run ID                                                | Verdict                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | --------------------------- | ----------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-14 | M3c P0 mutation scope       | `m3c-p0-mutation-scope-2026-11-14`                    | accepted (entrypoint exclusion) | 141 files and 13,223 mutants scored 69.60/79.64 against the 95.89/96.24 floor; the eight existing packages held at 96.05/96.32. Five direct-execution entrypoints (366 mutants, 0% coverage) are excluded because Stryker's per-test coverage cannot see a separate Node process and child-process tests do not activate mutants. No other file is excluded, no threshold or existing floor is lowered, and no baseline is recorded until the remaining scope passes.                                                                                                                                                          |
| 2026-11-15 | M3c P0 mutation coverage    | `npm run mutation`                                    | accepted (floor recorded)       | 12,793 scorable mutants: 12,301 detected, 443 survived, 49 no-coverage; 75 runtime errors are excluded. Global **96.15 total / 96.52 covered**, up from the 95.89/96.24 floor. Floors are now recorded for every package in scope: `packages/eval-harness` 96.18/96.60, `tools/eval-harness-cli` 96.53/96.99, `tools/agent-harness-bench` 94.70/95.26, `tools/annotation-kit` 98.95/98.95, `tools/routing-bench` 96.97/96.97. No existing floor is lowered, no threshold is changed and no file is excluded. Five findings from the coverage work are fixed in this layer (`a84c142`, `f3d3eb2`), each with a regression test. |
| 2026-11-16 | M3c P6 baseline — English   | `m3b-v2-baseline-en-r3`                               | reference reading               | 36/36 trials, 0 failures; required speaker 0.676, silence appropriate 0.000, acceptable 0.500; `pass^1`/`pass^3` 1.0. The fixed-rotation arm speaks on every turn, so the silence class is zero by construction.                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-11-16 | M3c P6 capability — English | `m3b-v2-det-persona-en-r3` vs `m3b-v2-baseline-en-r3` | **inconclusive** (below MDE)    | 36/36 trials, 0 failures; required speaker 0.765 vs 0.676 (+0.088, MDE 0.15), silence 0.667 vs 0.000 (+0.667), acceptable 0.750; invariants and `pass^3` hold. No policy adopted.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-11-16 | M3c P6 baseline — French    | `m3b-v2-baseline-fr-r3`                               | reference reading               | 36/36 trials, 0 failures; required speaker 0.618, silence appropriate 0.000, acceptable 0.438; `pass^1`/`pass^3` 1.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-11-16 | M3c P6 capability — French  | `m3b-v2-det-persona-fr-r3` vs `m3b-v2-baseline-fr-r3` | **inconclusive** (below MDE)    | 36/36 trials, 0 failures; required speaker 0.647 vs 0.618 (+0.029, MDE 0.15), silence 0.667 vs 0.000 (+0.667), acceptable 0.667; invariants and `pass^3` hold. No policy adopted.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-11-16 | M3c P6 shadow comparison    | `m3b-v2-shadow`                                       | recorded, no adoption           | 288 records over 12 holdout tasks per language; agreement `det-central` 1.000, `jev-persona` 0.719, `jev-central` 0.635; shadow cost $0.0112. Shadow records never changed a session event.                                                                                                                                                                                                                                                                                                                                                                                                                                    |

The P6 readings are on `m3b-v2` with grader `1.1.0`. The class MDEs are
registered in the M3c plan (Metrics and MDE): **0.15 speak-required** and
**0.25 silence-required**. The M3b 0.20 figure was the acceptable-speaker axis on
`m3b-v1`; it does not govern these class axes. They are not comparable
with the M3a routing numbers or the M3b `m3b-v1` numbers: the dataset, the class
axes and the grader version all changed. `pass^3` uses `k = 3`; with `n = 3` it
is descriptive only, and the independence gap (shared process, provider and
filesystem) remains. Live Gemma spend is unmeasured: the run records usage but
not a priced total, so the $5 cap is not claimed. The French baseline and det-persona runs both use 250 ms provider pacing
after transient provider call failures, so the arms differ only in policy; the
failed attempts are not evidence.

Silence is reported, not registered as a guardrail: its baseline is 0, so a
baseline-relative guardrail could never fail. It improves by +0.667 in both
languages, above the 0.25 silence-required MDE registered in the M3c plan.

## M3d implementation

D0 records the P6 finding and pre-registers the repair. The row below is a
diagnostic finding, not a capability verdict; no M3d run exists yet.

| Date       | Gate                            | Run ID                               | Verdict                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------- | ------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-23 | M3d D0 routing-contract finding | `m3c-p6-routing-arm-findings` (note) | recorded; no P6 verdict or gate changed | A read-only analysis of the P6 artifacts and the code found that the runtime contract did not carry scenario ownership and classified turns by keyword relevance rather than by the required response. Verified in code: ownership is absent from `RoutingContext` (`packages/routing-policy/src/schemas.ts`, `packages/persona-kit/src/routing-context.ts`); direct address is an automatic request and the first rank key (`derive.ts`, `rank.ts`); the Jev questions ask for a relevant contribution (`packages/eval-harness/src/jev/routing.ts`); matching is whole-term exact (`features.ts`); equal matches fall back to recency (`rank.ts`); `coveredObjectiveIds` is never populated. Recorded shadow data shows `jev-persona` fell back on 26/48 English and 30/48 French contexts. P6 verdicts stand: English inconclusive, French inconclusive, no policy adopted; the post-hoc Jev tables are diagnostic and not a selection. |

### D0 pre-registration (2026-11-23)

The M3d contract is frozen before any code or run:

- **Named non-owner.** The owner answers; the named persona is a distractor.
  Architecture Plan v5 §3.3 puts ownership fit first. `m3b-v2` goldens and
  guideline v2 are unchanged.
- **Arms.** `jev-central` and `jev-persona` only, with fixed rotation as the
  reference reading. No deterministic candidate or diagnostic run.
- **Metrics.** Speak MDE stays 0.15 over fixed rotation (`>= 0.826` English,
  `>= 0.768` French over three rounds). Silence has an absolute floor of 0.75,
  because its baseline is a structural zero. The incumbent `det-persona`
  readings (0.765 EN / 0.647 FR speak, 0.667 silence) are a second floor.
- **Move contract.** Atomic Jev Nouls for closing, self-answer, thinking aloud
  and side comment. No broad "should this persona speak" question and no model
  ownership judgment.
- **Fallback.** Unsettled answers use the owner rule only: speak only when one
  owner is resolved and the settled move answers do not name a self-directed
  move; otherwise yield. An unsettled answer is a decision, not a failure. Any
  failed Jev call — timeout, transport error, or an invalid or missing
  Noul/Choice answer — is `infrastructure_incomplete`, never a decline, a pass
  or a zero.
- **Selection.** Both languages must clear every floor. If both arms pass, rank
  by speak, silence, cost, p95 latency, then fallback rate. If neither passes,
  no arm is adopted and no arm is called the winner.
- **Product.** The shipping `det-persona` path is unchanged in M3d. Product
  wiring is a separate layer and needs its own approval.
- **Versions.** Routing context and decision schemas move to `1.1.0` for the
  additive ownership field; rubric `m3d-routing-rubric-v2`. `coveredObjectiveIds`
  stays in the schema and in the live context so the frozen
  `synthetic-routing/1.0.0` and `1.1.0` tasks keep parsing; rubric v2 drops the
  coverage question, and removing the field is a future major-version job. The
  turn-taking grader stays `1.1.0`, so the P6 manifests remain valid and are not
  re-run.

The plan is [M3d Plan: Routing Contract Repair and Jev Arm Comparison](https://app.notion.com/p/42283d257ddf811f909fd96e21494c30)
in Notion, with a local copy at `docs/plans/m3d-plan-routing-contract.md`. Stack
base is `feat/m3c-p6-rebaseline` at `bf60013`; D0 is docs only.

### D3 offline calibration (2026-11-24)

D3 compares the two Jev topology arms on calibration only. It changes no
contract, label, data, threshold, manifest floor or gate.

**Data-source finding.** The four `m3b-v2` P6 manifests are holdout-only and no
calibration transcript was saved. The plan's "rebuild contexts from the saved P6
transcripts" therefore had no calibration source. D3 produced one fixed-rotation
reference round per language over the 10 calibration tasks
(`m3d-cal-reference-en-r1`, `m3d-cal-reference-fr-r1`), then rebuilt every
routing context from those saved transcripts. The reference is the reading the
plan already keeps; the arms, labels, metrics, thresholds and selection rule are
unchanged, and no holdout context was read.

| Date       | Gate               | Run IDs                                                    | Verdict              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ------------------ | ---------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-24 | M3d D3 calibration | `m3d-calibration-offline-en`, `m3d-calibration-offline-fr` | complete, diagnostic | 40 contexts per language, 0 incomplete decisions, context and decision invariants hold. EN: speak 0.929 (26/28), silence 0.800 (8/10), acceptable 0.900; owner fallback `jev-central` 0% (0/40), `jev-persona` 2.5% (1/40); central $0.00176001 and p95 241 ms vs persona $0.00360570 and p95 994 ms. FR: speak 0.786 (22/28), silence 0.800 (8/10), acceptable 0.800; owner fallback central 27.5% (11/40), persona 45% (18/40); central $0.00200164 and p95 507 ms vs persona $0.00413364 and p95 1218 ms. The arms tie on every class in both languages; the central topology is cheaper and faster. Both runs disable the Jev cache, so the latency and cost readings are live and no answer was served from an earlier run. A rerun of the same reference after the D3 review reproduced every class, family and decline reading; only live latency and the occasional boundary Noul answer moved, which the recorded run keeps as recorded. |

Family diagnosis, recorded as findings and not fixed in D3:

- `TT-Q2` is 1/3 in both languages. The learner muses ("I wonder whether…",
  "Je me demande si…") and Jev answers all four move Nouls settled-no, so the
  owner rule speaks. A model move error, not a contract gap.
- `TT-S5` is 2/4 in both languages. Ownership keywords are coarse and shared:
  `demo`/`démo` is a keyword of four handover owners, and `suivi` (peer) and
  `client` (manager) co-occur, so several owners match. The contract then yields
  or resolves by direct address, as `m3d-routing-rubric-v2` states.
- French scope shares `notifications` between the peer impact objective and the
  manager priority objective, so impact questions are unresolved or resolve to a
  directly addressed non-owner.
- `terminée` does not match `terminé`: whole-term matching is C4 and unchanged.

No iteration was applied. Each observed decision is produced by a written rule;
the residual misses are a model move error and coarse or shared ownership terms,
which is a data-quality question rather than an open contract ambiguity.
Changing owner keywords after reading calibration labels would fit the data to
calibration, and D4 is the pre-registered holdout test. The D4 row records what
the frozen contract does on holdout.

Mutation scope: the two direct-execution entrypoints
`tools/routing-bench/src/m3d-calibration.cli.ts` (resolve hook) and
`tools/routing-bench/src/m3d-calibration.ts` (fs, environment and live Jev
wiring) join the entrypoint exclusions, for the same reason as
`m3b-shadow.cli.ts` and `m3b-shadow.ts`: they run in a separate Node process, so
per-test coverage cannot see them. The pure modules stay scored:
`packages/eval-harness/src/runner/calibration-contexts.ts`,
`packages/eval-harness/src/runner/routing-families.ts` and
`tools/routing-bench/src/m3d-calibration-summary.ts`. Remove the exclusion when
the script becomes importable by a unit test without live wiring.

### D4 holdout pre-registration (2026-11-24)

D4 applies the selection rule frozen in the M3d plan to the `m3b-v2` holdout. The
rules below are written before the run and are not changed afterwards.

**Data.** The recorded fixed-rotation holdout sessions
`m3b-v2-baseline-en-r3` and `m3b-v2-baseline-fr-r3`: 12 tasks per language, four
learner turns each, three rounds. The routing contexts are rebuilt from those
transcripts with the same builder D3 used; the golden labels are joined after the
context and never enter it. No session is run again, so no new holdout data is
created.

**Readings.** The offline comparison scores routing decisions against the same
golden speaker labels the session runs score. The session metric names map onto
the class readings:

- `turn_taking.required_speaker_rate` = the completed `speak` class rate.
- `turn_taking.silence_appropriate_rate` = the completed `silence` class rate.
- `acceptable_speaker_rate` and every family reading stay diagnostic.

`mixed` labels are counted and excluded, and an incomplete decision is never a
pass and never a zero.

**Floors**, per language, from the pre-registered MDE over the fixed-rotation
baseline and the recorded `det-persona` incumbent:

| Language | Speak floor | Silence floor | Incumbent speak | Incumbent silence |
| -------- | ----------: | ------------: | --------------: | ----------------: |
| en       |       0.826 |          0.75 |   13/17 = 0.765 |      8/12 = 0.667 |
| fr       |       0.768 |          0.75 |   11/17 = 0.647 |      8/12 = 0.667 |

**Adoption.** An arm is adoptable only when, in both languages, it meets the
speak floor, the silence floor and the incumbent readings, and completes every
decision. Zero incomplete decisions is the failure guardrail; a timed-out or
errored call makes that arm unadoptable and the run exits 1 rather than reading
as finished. Latency, cost, fallback and unsettled rates are diagnostics and
selection keys, not separate gates.

**Selection.** If both arms are adoptable, rank them by the pre-registered order:
worst-language speak rate, worst-language silence rate, total cost per completed
decision, worst-language p95, worst-language fallback rate. The better arm is
adopted. If exactly one arm is adoptable, it is adopted. If neither is adoptable,
no arm is adopted and no arm is called a winner.

**Unchanged.** No threshold, floor, golden label, task, manifest, baseline,
scenario fact or owner keyword moves in D4. A miss found on holdout is a finding,
not an iteration trigger; D5 is the live confirmation, not a second attempt at
selection.

### D4 holdout result (2026-11-24)

Run ID `m3d-holdout-offline`, generated by `npm run eval:m3d-d4` from the
recorded `m3b-v2` holdout histories. 144 contexts per language (12 tasks × 4
learner turns × 3 rounds), every decision complete, both invariants hold, and
the run exited 0 because it finished. No arm is adopted.

| Language | Arm           | Speak (required) | Silence | Acceptable | Fallback |        Cost |    p95 |
| -------- | ------------- | ---------------: | ------: | ---------: | -------: | ----------: | -----: |
| en       | `jev-central` |   90/102 = 0.882 |   0.833 |      0.875 |    9.0 % | $0.00634229 | 496 ms |
| en       | `jev-persona` |   90/102 = 0.882 |   0.833 |      0.875 |    8.3 % | $0.01299304 | 450 ms |
| fr       | `jev-central` |   75/102 = 0.735 |   0.972 |      0.806 |   30.6 % | $0.00725285 | 356 ms |
| fr       | `jev-persona` |   75/102 = 0.735 |   1.000 |      0.813 |   47.2 % | $0.01497292 | 415 ms |

Verdict, by the pre-registered rule: **no arm is adopted and no arm is called a
winner.** English clears the speak floor (0.882 ≥ 0.826), the silence floor
(0.833 ≥ 0.75) and both incumbent readings. French clears silence (0.972 and
1.000 ≥ 0.75) but misses the speak floor: 0.735 < 0.768, four decisions short of
the 79/102 the floor needs. Adoption requires both languages, so neither arm is
adoptable. The floor is not moved.

The two topologies agree on the speak class in both languages (0.882 EN, 0.735
FR) and on silence and acceptable in English. In French they differ slightly on
silence (0.972 vs 1.000) and acceptable (0.806 vs 0.813). The per-persona arm
never changes which turn speaks, which is the plan's frozen expected finding:
under ownership-first the move belongs to the utterance and the owner is public
data, so the per-persona batches add cost without changing the speak decision.
The persona arm is not cheaper and is not faster in French.

Family diagnosis, recorded as findings and not fixed in D4:

- `TT-D1` 12/24 in French (21/24 in English): the learner addresses Catherine,
  but the label gives the topic to Samir. The fact reads `liste d’actions` with a
  typographic apostrophe while the utterance uses `liste d'actions`, so the peer
  claim never matches; a coarser manager claim (`liste de vérification…`) matches
  on `liste`, and the single-owner rule then speaks for the addressed manager.
  Keyword granularity plus the C4 whole-term apostrophe variant, as in D3.
- `TT-S3` 3/12 and `TT-S4` 9/12 in French: `notifications` and `risque` are
  keywords of both the peer impact objective and the manager priority objective,
  so the owner set is unresolved and the contract yields.
- `TT-S6` 12/15 in French: `liste d’actions` again matches the coarser `liste`
  claim, so both owners match and an unaddressed question is unresolved.
- `TT-Q2` 3/9 in English: the learner muses ("The client seemed quieter than
  usual"), Jev answers the move Nouls settled-no, and the owner rule speaks. A
  model move error, unchanged from D3.

No owner keyword, scenario fact, threshold, floor, golden label, manifest or
baseline changed. The French miss is a data-quality finding on the frozen
contract; changing keywords after reading holdout labels would fit the data to
the test. D5 is the live confirmation of the frozen contract, not a second
selection attempt.

### D5 close-out (2026-11-24)

D4 adopted no arm, so the plan's live phase — "live run of the arms that passed
D4" — has no candidate. No Jev live policy adapter was added, because nothing
would call it: the architecture rule forbids speculative code, and the product
default stays `det-persona`. `apps/cli` still wires `det-persona`, and no live
routing policy is registered anywhere.

**Result.** The M3d contract repair is complete and no routing policy is
adopted. English clears the frozen floors on holdout; French misses the speak
floor by four decisions. The P6 verdicts stand: English inconclusive, French
inconclusive, no policy adopted. Only a new pre-registered run can change that.

**Spend.** D3 and D4 were offline comparisons with the Jev cache disabled.
Recorded Jev spend, all arms and both languages: D3 $0.00536571 (en) + $0.00613528
(fr); D4 $0.01933533 (en) + $0.02222577 (fr); total **$0.05306209**. D5 spends nothing on
routing because no live arm ran, and the regression replays spend nothing
because they read recorded transcripts. This is the recorded spend, not a claim
about discarded development runs.

**Regression floors, re-run on this branch:**

| Suite                              | Run ID                 | Verdict  | Reading                                                                                                       |
| ---------------------------------- | ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `m0-canned-replay` (G1)            | `m0-canned-replay`     | accepted | deterministic 1.000 (delta 0), failure 0, plain text 1.000, 4 guardrails and all invariants hold              |
| `m2-persona-replay-v2`             | `m2-persona-replay-v2` | accepted | deterministic 1.000 (delta 0), failure 0, plain text 1.000, 7 guardrails and all invariants hold              |
| task validator (G3)                | —                      | pass     | 0 violations over `evals/`                                                                                    |
| full mutation (`npm run mutation`) | —                      | pass     | every package at or above its recorded floor; `packages/eval-harness` 96.33 %/96.73 % against 96.18 %/96.60 % |

The suites ran into `evals/results/m3d-d5-regressions/` so the accepted run
directories stay untouched. No threshold, baseline, manifest or golden file
changed in D5.
