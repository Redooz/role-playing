# French grader spike — 2026-11-09

Status: **completed. No grader switch.**

## Setup

- 30 French traces from the M2 annotation set (15 candidate
  `m2-persona-scenarios-lk`, 15 baseline `m2-persona-baseline-lk`).
- Reference: consensus of the two agent annotation passes (`4–5 = yes`,
  `1–3 = no`). Ambiguous rows are excluded from the binary comparison.
- Jev: `typesafe/jev-1.14`, rubric v2, 0.75 line.
- Mistral Large 3: `mistralai/mistral-large-2512` via OpenRouter, 3 samples per
  judgment at temperature 0.7; `p_yes` = yes votes / 3. About 450 calls, roughly
  $0.15.
- Mistral Large 4: not usable for this protocol. OpenRouter rejects `logprobs`
  (“Logprobs are not enabled for this model”), and the model forces reasoning;
  a one-token probability is not available.

## Results against agent consensus

| Axis                   | n   | yes | Jev BA @0.75 | Mistral BA @0.5 | Jev AUC   | Mistral AUC | Jev kappa | Mistral kappa |
| ---------------------- | --- | --- | ------------ | --------------- | --------- | ----------- | --------- | ------------- |
| `persona.consistency`  | 27  | 15  | **1.000**    | 0.542           | **1.000** | 0.531       | **1.000** | 0.085         |
| `language.quality`     | 30  | 20  | **0.800**    | 0.650           | **0.882** | 0.662       | **0.571** | 0.308         |
| `register.fit`         | 30  | 20  | **0.925**    | 0.250           | **1.000** | 0.300       | **0.791** | -0.500        |
| `response.clarity`     | 30  | 30  | n/a          | n/a             | n/a       | n/a         | n/a       | n/a           |
| `objective.completion` | 23  | 18  | 0.861        | **0.917**       | **0.944** | 0.917       | 0.531     | **0.685**     |

## Interpretation

- **Jev v2 is better on the French axes that were weak under v1.** Persona,
  language and register all separate better than Mistral.
- **Mistral’s register is inverted.** It says yes to the peer traces where the
  persona uses `vous` after the learner uses `tu`, and no to the formal client
  traces. It did not follow the v2 `tu`/`vous` criterion.
- **Objective is mixed.** Mistral has the better binary agreement; Jev has the
  better ranking (AUC). Neither dominates.
- The v1 finding that Jev’s French `register.fit` was near chance did **not**
  reproduce under rubric v2. The explicit `tu`/`vous` and accent wording appears
  to have fixed the signal on this sample.

## Caveats

- The reference is agent labels, not human labels; the sample is 30 traces.
- Rubric and labels are both provisional, so this is a signal, not a final
  calibration.
- Mistral Large 4 was not tested as a decision model because it rejects
  `logprobs` and forces reasoning on OpenRouter.

## Recommendation

- **Keep Jev v2 for M2.** Do not switch to Mistral Large 3.
- If a second grader is still wanted later, test Mistral Large 4 with a proper
  reasoning budget and a human audit, or a strong multilingual model with a
  calibrated verbalised probability. The current evidence does not justify a
  switch.
