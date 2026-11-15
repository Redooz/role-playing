---
name: pass-k-reliability
description: >
  Measure and report reliability across repeated trials with pass^k. Use when choosing how
  many trials or rounds to run, when asked "does this work every time" or "how reliable is
  it", when a suite passes but users still hit failures, when comparing pass@k with pass^k,
  or when a low pass^k sits beside a healthy pass^1. Covers the arithmetic, per-task
  aggregation, independence assumptions, and pre-registration rules.
---

# Report reliability with pass^k

## What it measures

pass^k is the probability that an agent succeeds on **all** k independent trials of the same
task. It answers "does this work every time we need it to?", not "did it work when we looked".
It comes from τ-bench (Yao et al., 2024) as a reliability counterpart to the usual pass rate.

pass^1 is the ordinary per-trial success rate. pass^k for k > 1 is the bar a user actually
experiences: it worked, first time, again, again.

## The arithmetic, and why it bites

If a task succeeds 75% of the time independently:

| k trials | pass^k |
| --- | --- |
| 1 | 0.750 |
| 2 | 0.563 |
| 3 | 0.422 |
| 5 | 0.237 |
| 10 | 0.056 |

0.75³ ≈ 0.42: three trials turn a "mostly works" agent into one that fails most sessions. The
same decay holds at higher per-trial rates:

| per-trial success | pass^3 | pass^5 | pass^10 |
| --- | --- | --- | --- |
| 0.90 | 0.729 | 0.590 | 0.349 |
| 0.95 | 0.857 | 0.774 | 0.599 |
| 0.99 | 0.970 | 0.951 | 0.904 |

Read the table backwards for planning: for a 90% chance of three clean trials, the per-trial
rate must be 0.90^(1/3) ≈ 0.965. For ten clean trials it must be 0.989. Reliability targets
translate into a much stricter per-trial bar.

## pass^k is not pass@k

They answer opposite questions:

- **pass@k** — probability that at least one of k attempts succeeds. The ceiling: can it do it
  at all, if we keep trying? Used where you can sample and pick.
- **pass^k** — probability that every one of k attempts succeeds. The floor: can we rely on it?

For k = 3 and a per-trial rate of 0.75: pass@3 ≈ 0.98, pass^3 ≈ 0.42. Same agent, same data,
opposite headlines. Quoting the wrong one is how "98% on the benchmark" and "users hit
failures constantly" coexist.

## Compute per task

With n trials per task and c successes, the task's pass^k is the fraction of k-subsets that are
all successes:

```
pass^k = C(c, k) / C(n, k)
```

For k = 1 this collapses to c/n, the per-trial rate, which is why the two are usually reported
together.

Requirements: trials independent and clean; n ≥ k; estimates get noisy quickly as k approaches
n.

**Do not aggregate per-trial rates across tasks and then exponentiate.** A suite of six tasks
at 50%, 100%, 100%, 100%, 100%, 100% has a mean of 0.917, but nobody's session is 91.7%
reliable: one task in six always fails. Compute per task and report the distribution.

## Assumptions and limits

- **Independence.** Correlated trials — same seed, warm cache, shared module state, a provider
  down for the whole run — break the assumption. In practice, correlated trials usually
  *inflate* pass^k, because an environment-wide failure looks like a task characteristic
  rather than a flake.
- **No partial credit.** Two of three clean is a fail for k = 3. That is the point; choose k
  deliberately rather than inheriting it.
- **It cannot separate a hard task from an unreliable agent.** A task at pass^1 = 0 and a task
  that flakes half the time both drag the number down. Report pass^1 per task alongside.
- **It punishes a narrow grader.** If only one phrasing counts as success, pass^k measures the
  grader's strictness as much as the agent's consistency.

## Rules

- Report pass^1 and pass^k together, never pass^k alone.
- Pre-register k and the target with the run. Changing k after seeing results is the same
  failure as lowering a threshold.
- Report per segment — language, locale, input class. One segment's reliability says nothing
  about another.
- Choose n generously. At n = k the estimate is extremely noisy; the point is a number you can
  defend.
- A low pass^k with a healthy pass^1 is a **variance finding, not a quality finding**. Look for
  the nondeterminism — sampling temperature, seeds, tool timing, retries — before rewriting
  prompts.
- Do not quote a reliability figure from a semantic grader that has not been checked against
  human labels. pass^k amplifies the grader's consistency, including its mistakes.

## Background

pass^k was introduced in τ-bench (Yao et al., 2024).
