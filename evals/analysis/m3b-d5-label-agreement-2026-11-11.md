# M3b D5 speaker-label agreement — 2026-11-11

Status: **provisional, below the pre-registered exact-agreement target**.
Source: two independent context-free agent passes over 24 session tasks
(`standup-scope-change`), 4 learner turns each, 96 labels total (48 English,
48 French).

## Result

| Language | Exact agreement | Target | Outcome |
| -------- | --------------- | ------ | ------- |
| English  | 36 / 48 = 0.750 | 0.80   | below   |
| French   | 36 / 48 = 0.750 | 0.80   | below   |

The two passes disagreed on 24 of 96 labels. Almost every disagreement was the
same shape: one pass accepted both personas for a closing "what next / who owns
it" turn, the other accepted only the manager. There were also four
`allowUserYield` disagreements on the opening "can someone summarise" turn.

## Adjudication

A third context-free pass saw only the disagreeing turns and the two candidate
sets. It accepted both personas for all 24 disagreements and rejected learner
yield. The stored labels use that adjudication. This is a consensus label set,
not evidence that the two original passes met 0.80.

## Consequence

- The labels are `draft` and `labelSource: agent`. They are not human ground
  truth and cannot make a semantic gate `stable`.
- The pre-registered 0.80 exact-agreement target is **not met**. Do not lower
  the target or call the labels stable. D6 must report this limitation with the
  capability run.
- A future human double-label pass can replace these labels; a changed label set
  gets a new file version, not an edit to this measurement.
