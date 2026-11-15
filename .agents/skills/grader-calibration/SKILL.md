---
name: grader-calibration
description: >
  Choose, tune, and validate a semantic grader's decision threshold with evidence. Use when
  setting a threshold for a decision model or LLM judge, choosing between a code grader and a
  model grader, defining minimum precision and recall, measuring agreement with human labels,
  or reading a probability as confidence. Covers cost-of-error first, stratified k-fold
  threshold selection on saved scores, one holdout evaluation, calibration curves, and why
  0.50 is arbitrary.
---

# Choose and validate a semantic grader

## Order of operations

Decision models and LLM judges turn a probability into yes/no at some threshold. That threshold
is a product decision, not a default. Work in this order:

1. Decide the cost of each mistake, then set a **minimum precision** and a **minimum recall**
   for the use case.
2. Exclude any candidate that cannot meet both, at any price.
3. Rank the survivors by cost.
4. Choose the threshold on calibration data only.
5. Measure once on held-out data.
6. Calibrate the probabilities only if scores will be read as confidence.
7. Record the threshold, the procedure that produced it, and the data it was tuned on.

A court wants high precision; screening wants high recall. The two directions are not
interchangeable.

## The default threshold is arbitrary

Every service turns its probability into a verdict at 0.50. That is a convention, not a
finding. On one published comparison of six decision models over 98 human-labelled traces, the
best threshold per model spanned 0.06 to 0.72, in both directions. A single default cannot be
right for all of them.

Keep the default until your own labels say otherwise. "Tuned" is not a synonym for "better": in
that same study, one model improved on the tuning set and landed slightly below its untouched
default on held-out data.

## Do not report a composite score

F1 weighs a false alarm and a missed failure equally. Use it to rank candidates inside an
analysis; never report it as an axis, and never optimise it without minimums. Report precision
and recall per axis, plus the number of folds where no threshold qualified.

## Threshold procedure

Preconditions:

- roughly 80–100 human-labelled trials at minimum; smaller sets cannot separate a real effect
  from noise;
- labels split by speaker or session rather than utterance, so the same speaker cannot appear
  on both sides;
- raw probabilities retained per trial, so the analysis never re-calls the provider;
- rubric, grader, extraction, and score-matrix versions frozen. Any change is a new run, not a
  tweak.

Steps:

1. Select the threshold on the calibration split only. Use stratified k-fold over the saved
   scores: for each fold, choose the threshold on the training part, restricted to values that
   meet the pre-registered minimum precision and recall.
2. Where no threshold qualifies, record the fold as **infeasible** and say so. Do not relax a
   minimum to make a fold qualify.
3. Measure once on the holdout. Report held-out precision and recall per axis, the count of
   infeasible folds, and the same figures at the default 0.50 for comparison.
4. Fit any probability correction on training folds and apply it out-of-fold. Keep the
   correction only if it improves on held-out data; for some models it does nothing or slightly
   hurts.

## Minimum detectable effect

A held-out difference smaller than roughly one standard deviation of the fold-to-fold variation
is not a finding. On a set around 100 records that was about 0.013. Pre-register the effect size
you will treat as real.

## Agreement is not calibration

Two different things carry the name:

- **Agreement with people** — how often the model's verdict matches an expert's on the same
  transcript. This decides whether a semantic axis is usable at all.
- **Probability calibration** — whether a score of 0.8 means roughly 80 in 100. This decides
  whether a threshold or a confidence reading is meaningful. It is worthless if agreement
  fails.

### Measuring agreement

1. Experts label first, blind to the model. The golden labels are the reference; the model
   never informs them.
2. Double-label a subset and report agreement between the two experts. That is the ceiling;
   demanding 95% model agreement when experts disagree on 15% measures noise.
3. Pre-register the acceptable divergence before looking: an overall disagreement rate plus a
   separate tolerance for each direction. A verdict that invents a failure and one that misses
   a failure are not the same mistake.
4. Report per axis and per segment.
5. Read the disagreements, not only the rate. Each is one of three things: the rubric is
   ambiguous, the transcript lacks the evidence the judgment needs, or the model is wrong. Fix
   the first two before rewording the question; wording is the last lever, not the first.
6. Check agreement on cases not used to write the rubric, or it is memorisation.
7. Re-establish agreement whenever the reference moves: rubric version, model version,
   extraction version, or a new language.

If agreement sits below the pre-registered bar, that is a finding about the rubric or the axis,
not a reason to soften the bar.

## Prefer code when the failure is mechanical

A model adds cost, latency, variance, and a calibration obligation. Reach for one only when the
judgment is semantic.

- **Decidable in code:** structural invariants (turn order, single writer, monotonic sequence,
  schema validity), existence and counting (did the tool call happen, how many retries), exact
  values (ids, dates, times, language), hard limits (token, time, frame budgets).
- **Needs a model:** politeness, register, whether a refusal was appropriate rather than merely
  present, whether an objective was met when completion exists only as language.

Mixed shape: code extracts and counts, the model supplies the judgment, code aggregates.
Counting never moves into the model.

## Background

The threshold and calibration method is from Hamel Husain and Antaripa Saha, "How To Use
Decision Models for Evals" (2026). The agreement discipline is standard grader-validation
practice.
