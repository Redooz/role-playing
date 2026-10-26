# Suite manifests

Pre-registered eval manifests (M0 D3). A manifest is the complete definition of
one evaluation run: which evaluation suite, which tasks, which grader, the
limits, and the gates. The evaluation harness validates it before it executes
anything and refuses an incomplete one, naming every missing field (gate G2). The
manifest hash (`canonicalJson` → SHA-256) is stored with the run.

| File                                | Status       | Purpose                                                                             |
| ----------------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| `m0-canned-replay.json`             | schema-valid | Gate G1: two canned rounds over all six synthetic EN/FR tasks (12 trials).          |
| `m0-incomplete-missing-limits.json` | **invalid**  | Test/doc task: no `limits` section. The harness must reject it. Never run it in CI. |

The `grader.kind` field states which of the three grader types produced the
scores: `code`, `system-one-model`, or `human`. M0 uses `code` only. A
`system-one-model` grader must also name its pinned model.

Every manifest also declares `run.purpose`:

- `capability` — what can the agent do well? The target must show a real
  improvement; new behaviour enters here.
- `regression` — does the agent still handle every task it used to? The primary
  axis is held at the baseline and `minimumDetectableEffect` must be `0`;
  every axis is a non-regression gate.

`m0-canned-replay` is a regression eval: it protects deterministic replay.

`m0-canned-replay.json` pre-registers baseline readings for the harness axes
(`replay.deterministic_rate`, transcript schema/content-class rates, guard
violations and failure rate) because M0 has no feature behaviour to improve yet:
the gate is that the harness reproduces itself. Its target and guardrails refer
only to deterministic counts computed in code; grading stays an injected port so
the Jev grader can replace the M0 code grader later.

Register a new manifest for every behaviour-affecting change. Do not edit an
existing manifest to make a run pass: fix the feature, or write a new
pre-registration and record the decision in `evals/decisions.md`.
