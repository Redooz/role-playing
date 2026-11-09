# M2 annotation review — 2026-11-09

Status: **analysis and proposal only. No threshold or grader change applied.**

## What was measured

- Two blind agent passes over the M2 Langfuse queues: 30 English + 30 French traces
  each (15 candidate `m2-persona-scenarios-lk`, 15 baseline
  `m2-persona-baseline-lk`).
- All 60 queue items are `COMPLETED`. Pass 1 wrote 290 scores; pass 2 wrote 300.
  Your two original human traces were kept and re-scored by pass 2.
- Both passes used the same rubric (`m2-annotation-guideline-v1`) and were kept
  blind to each other, to Jev scores and to `grades.jsonl`.
- These are **agent labels**, not human labels. They are useful for triage and for
  a provisional threshold signal, not for human–Jev agreement.

## Agreement between the two passes

| Axis                 | Exact agreement | Ordinal agreement (QWK) | Binary agreement (kappa) |
| -------------------- | --------------- | ----------------------- | ------------------------ |
| persona.consistency  | 83%             | 0.85                    | 0.73                     |
| language.quality     | 100%            | 1.00                    | 1.00                     |
| register.fit         | 90%             | 0.95                    | 1.00                     |
| response.clarity     | 74%             | n/a (near-constant)     | n/a                      |
| objective.completion | 64%             | 0.74                    | 0.58                     |

Pass 2 was consistently more generous, especially on `objective.completion`
(mean 4.33 vs 3.95; 78% yes vs 59% yes). `objective.completion` is the least
stable axis and needs a sharper rule or a human tie-break.

## What the labels show

Two-pass averages, 1–5:

|                                | Candidate | Baseline |
| ------------------------------ | --------- | -------- |
| English — persona.consistency  | 4.6       | 1.9      |
| English — register.fit         | 5.0       | 3.1      |
| English — objective.completion | 4.5       | 3.5      |
| French — persona.consistency   | 5.0       | 3.0      |
| French — language.quality      | 5.0       | 3.2      |
| French — register.fit          | 4.3       | 3.7      |
| French — objective.completion  | 4.5       | 4.1      |

The main failure mode is role loss in the baseline: generic-assistant openings,
role inversion in the meeting-reschedule scenario, and “check with your manager”
when the persona is the manager. French baseline also shows missing accents and
hyphens and `tu`/`vous` mismatch. `response.clarity` is near-constant and does not
discriminate.

## Jev line at 0.50

At 0.50, Jev says “yes” to **100% of baseline task-help traces** in both
languages, while the annotators say yes to roughly 47–67%. The ranking is good
(AUC 0.93–1.00 on the substantive axes) but the cut-off is too permissive.

Rates of “yes” for `objective.completion`:

|                   | 0.50 | 0.70 | 0.75 | 0.80 |
| ----------------- | ---- | ---- | ---- | ---- |
| English baseline  | 100% | 80%  | 60%  | 27%  |
| English candidate | 100% | 100% | 93%  | 93%  |
| French baseline   | 100% | 67%  | 53%  | 33%  |
| French candidate  | 100% | 87%  | 87%  | 73%  |

Held-out check (tune on rounds 0–2, test on rounds 3–4, two-pass consensus):
overall balanced match 72% → 85%; task-help 50% → 87%; language 63% → 88%;
persona unchanged (already 100%).

## Proposal

1. Move `M2_JEV_THRESHOLD` from `0.50` to `0.75` **provisionally**, not now.
   `M2_JEV_THRESHOLD` is a code constant in
   `packages/eval-harness/src/jev/grader.ts` and is recorded on every grade row.
   It is not an environment setting.
2. Do not use 0.80: it starts rejecting good candidate French task-help traces
   (73%) for little extra gain.
3. `register.fit` in French is not a threshold problem: Jev barely ranks it
   (AUC 0.62 overall, 0.48 French). Revisit the question or use a
   French-specific grader.
4. Blocking rule: M2 plan §2 says “No Jev threshold tuning in M2. Keep the
   default 0.50 until our own labelled data justifies a change.” The two passes
   are agent labels, not human labels. Do not change the constant until a human
   pass confirms it on a held-out split.
5. Run a French-grader research spike (Mistral and alternatives) before changing
   the grader. Record the chosen model, API shape, probability/calibration method,
   cost and a pre-registered comparison on the 30 French traces.

## Artefacts

- Labels: `/tmp/opencode/annotation-kit/labels` (pass 1),
  `/tmp/opencode/annotation-kit-p2/labels` (pass 2).
- Agreement: `/tmp/opencode/agreement.json`.
- Threshold sweeps: `/tmp/opencode/threshold-analysis-*.json`,
  `/tmp/opencode/pooled-threshold.mjs`, `/tmp/opencode/holdout-threshold.mjs`.
- Reusable kit: `tools/annotation-kit/` on `feat/annotation-agents`.
