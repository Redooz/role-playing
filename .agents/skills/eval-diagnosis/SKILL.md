---
name: eval-diagnosis
description: >
  Diagnose why an LLM application is failing before changing anything. Use when a prompt,
  agent, or eval suite regresses or fails intermittently; when asked "why is this failing",
  "what should we fix first", or "where do we start with evals"; when triaging traces,
  naming failure modes, or deciding whether a failure is a comprehension, specification,
  or generalization gap. Covers trace-based error analysis, saturation, evaluator design,
  and the analyse-measure-improve loop.
---

# Diagnose a failing LLM application

## Start here

A failing application gives you a symptom. Before you change a prompt, a model, or an
architecture, find out which gap the symptom comes from. You cannot vibe-check your way to
understanding: if you cannot name the failure modes, you do not know what to fix.

## Tag the gulf first

| Gulf | The question it names | What it looks like | First remedy |
| --- | --- | --- | --- |
| **Comprehension** | Do we know what users send, and what the pipeline actually does? | A proof of concept that "kind of works"; nobody can name the failure modes; dashboards show numbers with no story | Error analysis on real traces |
| **Specification** | Does the instruction say what we mean? | Vague or contradictory prompts; the model rambles, guesses, burns tokens | Explicit constraints, positive and negative examples, define the ambiguous word |
| **Generalization** | Does it hold on the long tail, not just our examples? | Works in the demo; fails on a new input distribution, an edge case, an adversarial user | Decomposition, structured output, retrieval, drift monitoring |

Most failures in a new product are comprehension failures: the team has not looked at enough
real inputs to know what "good" means. Resist the urge to skip straight to the prompt.

## Specification is not generalization

The symptoms look alike; the fixes do not.

- "The prompt never said what 'quick' means" — **specification**. Fix the instruction.
- "The prompt is precise, but the task is too broad for one call" — **generalization**. Split
  the task, add structure, add retrieval, change the architecture.

Rewriting the prompt harder will not fix a task that needs decomposition, and decomposing a
task will not fix an instruction that was ambiguous. Tag the failure before choosing the lever.

## Analyse: name the failures

Error analysis on real traces, with a method rather than an impression.

1. **Open coding** — read individual traces and write free-form notes on what went wrong. No
   categories yet.
2. **Axial coding** — group the notes into named failure modes, with counts and exemplars.
3. **Saturation** — keep sampling until new traces stop producing new failure modes. A common
   rule of thumb: at least 30 examples, typically 50, sometimes 100+.

Two hard rules:

- **Domain experts label.** The people who know what "good" means have to be in the data; do
  not outsource the judgment.
- **The unit is the trace, not the aggregate.** A dashboard number cannot tell you which
  failure it is hiding.

A useful starting trick: define good by listing user unhappiness first ("allergic ingredient
present", "instructions unclear", "wrong complexity for the skill level"). The inverse of that
list is a specification you can actually write.

## Measure: one evaluator per observed failure

Each named failure becomes an evaluator. Prefer the cheapest thing that can decide it:

- **Reference-free** — check a property without a golden answer. Code assertions are exact,
  free, and reproducible.
- **Reference-based** — compare against a golden answer. Useful in CI, less useful on
  production traces.
- **LLM-as-judge** — for semantic judgments code cannot express. Only trustworthy once checked
  against human labels, kept binary rather than graded, and re-checked when the rubric, model,
  or language changes.

The discipline: measurement is built from observed failures, not from a wish list. Do not build
an evaluator for a failure nobody has observed. If the judge is unreliable, the measurement
layer is built on sand, and the whole loop inherits the error.

## Improve: one lever at a time

Change one thing, then re-run the same suite and compare against the baseline. Order by
cheapest and most attributable:

1. Prompt and specification fixes.
2. Architecture: decomposition, retrieval, structured output, a stronger model.
3. Fine-tuning last, only when the simpler levers are exhausted.

"Improve" is only meaningful against the previous two stages. Without an observed failure and a
reproducible measure, "it feels better" is not evidence.

## Where the loop breaks

- **Skipping analyse** — you build evals for imagined failures. The most common failure, and
  the one that looks like progress.
- **Measuring without a baseline** — any number reads as an improvement.
- **Improving without re-running** — the change and the claim are disconnected.
- **An unvalidated judge** — you are measuring the judge's taste, not the product's quality.
- **Overfitting to the eval set** — the suite stops predicting real-world quality while the
  loop keeps reporting green.
- **Jumping to fine-tuning** — a capability fix for what was a specification problem.

## Report

Report each axis and each segment separately; never average them into one number. A loop that
averages is a loop that hides.

## Background

The three-gulf framing and the analyse-measure-improve lifecycle are taught together in Hamel
Husain and Shreya Shankar's *AI Evals for Engineers and PMs*. The gulf framing also appears in
Shankar et al., "Steering Semantic Data Processing with DocWrangler" (arXiv:2504.14764).
