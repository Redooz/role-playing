# Run manifests

Pre-registered eval manifests (M0 D3). The runner validates a manifest before it
executes anything and refuses an incomplete one, naming every missing field
(gate G2). The manifest hash (`canonicalJson` → SHA-256) is stored with the run.

| File                                | Status       | Purpose                                                                               |
| ----------------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| `m0-canned-replay.json`             | schema-valid | Gate G1: two canned repetitions over all six synthetic EN/FR fixtures.                |
| `m0-incomplete-missing-limits.json` | **invalid**  | Test/doc fixture: no `limits` section. The runner must reject it. Never run it in CI. |

`m0-canned-replay.json` pre-registers baseline readings for the harness axes
(`replay.deterministic_rate`, trace schema/content-class rates, guard violations
and failure rate) because M0 has no feature behaviour to improve yet: the gate
is that the harness reproduces itself. Its target and guardrails refer only to
deterministic counts computed in code; scoring stays an injected port so the Jev
client can replace the M0 scorer later.

Register a new manifest for every behaviour-affecting change. Do not edit an
existing manifest to make a run pass: fix the feature, or write a new
pre-registration and record the decision in `evals/decisions.md`.
