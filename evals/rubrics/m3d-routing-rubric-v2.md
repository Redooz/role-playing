# M3d routing rubric v2

Version: `m3d-routing-rubric-v2`. Frozen before any M3d run. Any wording change
creates a new file and a new version; editing this one invalidates every Jev
cache entry keyed by it.

Covers the two Jev routing topologies in M3d: central selection and per-persona
turn requests. It replaces the broad contribution questions of
`m3a-routing-rubric-v1`; the M3a rubric and its recorded runs stay frozen.

## What the model answers

Both topologies receive `conversation`, `learner_utterance` and `owners` with
`topic`, `persona_ids`, the source (`fact` or `objective`) and its audit field.
The state then differs by topology:

- Central selection receives `eligible_personas`, each with its id, name, role
  and scoped responsibilities.
- Per-persona turn requests receive the single `persona` (id, name, role) and
  that persona's `objectives`.

The model answers atomic Nouls. It never answers "should this persona speak?"
and it never decides who owns a topic.

| Question id          | Meaning                                                                  | Used by          |
| -------------------- | ------------------------------------------------------------------------ | ---------------- |
| `closing_move`       | The learner ends, wraps up or concludes the exchange.                    | both topologies  |
| `self_answer`        | The learner answers a question they just asked themselves.               | both topologies  |
| `thinking_aloud`     | The learner reasons aloud with no addressee.                             | both topologies  |
| `side_comment`       | The learner remarks in passing without expecting a reply.                | both topologies  |
| `directly_addressed` | The learner names the persona or their role and speaks to them directly. | per-persona only |
| `best_speaker`       | One declared owner, chosen by a Choice restricted to that pair.          | central only     |

English and French copy live in `packages/eval-harness/src/jev/routing.ts`; that
file is authoritative for the exact instructions and criteria. The `best_speaker`
Choice is asked only when the turn has one declared pair of owners. It never
lists a non-owner.

## Thresholds

Noul answers use the frozen bounds `>= 0.7` yes and `<= 0.3` no. A value
strictly between them is unsettled. The bounds are not changed in M3d; a change
needs its own pre-registered calibration decision.

## Decision contract

Decisions are code, not model output:

1. A move answer `>= 0.7` for any of the four self-directed moves yields.
2. Otherwise a unique owner speaks and every other persona declines.
3. With no owner, no persona speaks; the learner continues.
4. A declared pair is resolved by the central Choice or by the persona-arm
   ranking (direct address, objective relevance, urgency, recency, seeded hash).
5. An unsettled move answer uses the owner rule only: speak only when exactly
   one owner is resolved — a single matched owner, or one of several owners
   named directly; otherwise yield.
6. A timeout, transport error or invalid/missing Noul or Choice answer is
   `infrastructure_incomplete`, never a decline, a pass or a zero. An answered
   but unsettled Noul is a decision, not a failure. A timed-out call is recorded
   with `timeout` as its cause and is counted apart from any fallback rate.

Ownership comes from public scenario facts and persona-scoped objectives. A named
non-owner is a distractor. `coveredObjectiveIds` is not part of this rubric; the
coverage question is retired with rubric v2.

## Version pinning

Every question batch sets `rubricVersion: m3d-routing-rubric-v2`. Because the
version, exact state and questions enter the Jev cache key, a replay with a
different owner list or utterance cannot reuse an old answer.
