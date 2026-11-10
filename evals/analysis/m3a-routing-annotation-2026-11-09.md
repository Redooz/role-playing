# M3a routing annotation — 2026-11-09

Dataset: `synthetic-routing/1.0.0`, 120 decision points (60 English, 60 French;
30 calibration + 30 holdout per language).

Method:

1. Built a blind bundle with `tools/annotation-kit/routing-bundle.mjs`.
2. Gave two independent context-free agent passes separate copies. Neither pass
   saw the other labels, the repository, task sources, split, arm, run or scores.
3. Each pass labelled all 120 cases with an accepted-outcome set:
   `acceptablePersonaIds` plus `allowUserYield`.
4. Compared the passes with `routing-analyze-agreement.mjs`.

## Agreement

| Scope   |   n | Exact |  Rate |
| ------- | --: | ----: | ----: |
| Overall | 120 |   120 | 1.000 |
| English |  60 |    60 | 1.000 |
| French  |  60 |    60 | 1.000 |

Unmatched task ids: none.

The pre-registered bar was 0.80 exact agreement per language. Both languages
cleared it. There were no disagreements to adjudicate.

## Status

The consensus labels are committed as 120 `status: draft` golden entries with
`routingOutcome.labelSource: "agent"`. They are **provisional agent labels**, not
human ground truth. Exact agreement between two LLM passes measures consistency,
not correctness. Only blind human double-labelling could make the routing
semantic gate `stable`.

Exact labels are not stored on tasks and never enter policy-visible state.
