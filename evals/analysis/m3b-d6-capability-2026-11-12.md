# M3b D6 — timing, frozen budgets and capability result

Date: 2026-11-12
Status: **recorded, no policy adopted**.

## Timing spike

Calibration-only, no provider call, 500 iterations per transition. Report:
`evals/results/m3b-timing/timing.json`.

| Transition                    | p50 (ms) | p95 (ms) | p99 (ms) |
| ----------------------------- | -------- | -------- | -------- |
| user commit → grant           | 0.0187   | 0.0597   | 0.1369   |
| 32 partials on one grant      | 0.0222   | 0.0811   | 0.1183   |
| interject request → new grant | 0.0041   | 0.0141   | 0.0277   |

The reducer is far below the live-turn floor. The frozen values stay at the
plan's provisional set because the spike found no reason to move them:

| Setting                  | Frozen              |
| ------------------------ | ------------------- |
| `requestWindowMs`        | 1,500 ms            |
| `grantTtlMs`             | 60,000 ms           |
| `minHoldMs`              | 800 ms              |
| `interjectExpiryMs`      | 1,000 ms            |
| `interjectCooldownMs`    | 3,000 ms            |
| `streakCap`              | 2 agent-only turns  |
| `replacementAttempts`    | 1                   |
| `maxConsecutiveFailures` | 2                   |
| Shadow decision deadline | 2,500 ms            |
| Capability rounds        | 3 (pass^3)          |
| Holdout tasks            | 6 per base language |
| Capability MDE           | 0.20                |
| Live spend cap           | $5                  |

Code: `packages/eval-harness/src/runner/m3b-budgets.ts` and
`packages/turn-arbiter/src/config.ts`.

## Capability comparison

Same six holdout tasks per base language, three rounds, fixed-rotation baseline
versus `det-persona`. Metric: `turn_taking.acceptable_speaker_rate`.

| Language | Baseline | `det-persona` | Delta  | MDE  | Verdict          |
| -------- | -------- | ------------- | ------ | ---- | ---------------- |
| English  | 0.750    | 0.667         | −0.083 | 0.20 | **rejected**     |
| French   | 0.583    | 0.667         | +0.083 | 0.20 | **inconclusive** |

Runs: `m3b-baseline-en-r3`, `m3b-baseline-fr-r3`,
`m3b-det-persona-en-r3`, `m3b-det-persona-fr-r3`.

Both arms completed 18/18 trials per language with zero failures, zero guard
violations, plain text 1.0, and `pass^1` / `pass^3` = 1.0. The invariants held.
The capability target did not: English regressed, French improved by less than
the pre-registered MDE. **No routing policy is adopted.** M3c can revisit the
policy after a larger sample or a different arm.

The one-round preliminary runs (`m3b-baseline-en`, `m3b-det-persona-en`,
`m3b-baseline-fr`, `m3b-det-persona-fr`) produced the same rates; the r3 runs
are the recorded comparison because they also support `pass^3`.

## Shadow comparison

Eval-only, holdout tasks, `det-persona` live decisions, 144 records. Shadow
records never changed a session event. Report:
`evals/results/m3b-shadow/summary.json` and `shadow.jsonl`.

| Arm           | Records | Agreement with live control | Cost (USD) |
| ------------- | ------- | --------------------------- | ---------- |
| `jev-persona` | 48      | 0.667 (32/48)               | 0.00399    |
| `det-central` | 48      | 1.000 (48/48)               | 0          |
| `jev-central` | 48      | 0.625 (30/48)               | 0.00162    |

Shadow cost: **$0.0056**. The eval runner does not meter capability spend, so the
combined M3b total is **unmeasured**; it is not claimed as below the $5 cap. No
arm is promoted.

## Findings

- The M3b control arm is fast enough that the request window, not the reducer,
  is the dominant grant delay.
- `det-persona` is not better than fixed rotation on this sample. It is worse in
  English and below the MDE in French.
- The shadow arms disagree materially with the live control, especially
  `jev-central`; that is a recorded comparison, not an adoption signal.
- The capability sample is 6 holdout tasks per language. Small differences are
  not claimed as signal; the report keeps the MDE visible.
