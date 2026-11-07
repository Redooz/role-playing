# Role-playing

Voice role-play platform for practising workplace English and French. Several AI
characters talk with one user in real time, and every change that affects
behaviour is checked by evals before it is accepted.

The repo is at milestone **M0** (build the eval foundation). There is no
application code and no audio path yet.

## Eval vocabulary

- **Evaluation suite** — a collection of related tasks that measures specific
  behaviour, for example `m0-canned-replay`.
- **Capability eval** — asks what the agent can do well. It must show a real
  improvement on its target. New behaviour enters here.
- **Regression eval** — asks whether the agent still handles every task it used
  to. Its primary axis is held at the baseline; every axis is a non-regression
  gate.
- **Task** — one test: its inputs and the success criteria registered for it.
  Task files live under `evals/tasks/`.
- **Trial** — one attempt at one task. In M0 a trial is one replay of one task.
- **Trial isolation** — every trial starts from a clean environment: its own
  clock, RNG stream, provider instance and copy of the task. A failed trial
  cannot change the next one. M0 covers in-memory state only; process/worker
  isolation, per-trial timeouts, and resets for an external database,
  filesystem, environment variables and live provider connections still need to
  arrive with the M1 agent harness.
- **Round** — one pass over every task in a suite. `rounds × tasks = trials`.
- **Grader** — the logic that scores an aspect of a trial. There are three types:
  **code-based** (deterministic checks and counts), **system-1-model-based** (a
  System One model such as Jev returns a calibrated probability), and
  **human-based** (an annotator's label, used as the reference).
- **Transcript** — the complete record of a trial: outputs, tool calls,
  reasoning, and every interaction.
- **Outcome** — the final state of the environment after a trial, for example
  whether a booking exists in the database. M0 has no environment, so it has no
  outcome checks; the current `invariants` are transcript checks.
- **Evaluation harness** — the infrastructure that runs evals.
- **Agent harness** — the system that lets a model act. It arrives in M1+.

## Requirements

- Node **>= 26** (see `engines` in `package.json`)
- npm 12
- Docker, only for the isolated LiveKit soak spike

## Commands

```sh
npm install
npm run lint            # ESLint
npm run format:check    # Prettier
npm run typecheck       # tsc project references
npm run test:unit       # fast suite, the PR gate
npm run test:bench      # wall-time measurements, never the PR gate

npm run validate:tasks  # task/golden validator (gate G3)
npm run eval -- run --manifest evals/manifests/m0-canned-replay.json
npm run eval -- compare --baseline evals/baselines/m0-canned-replay.json --run <run dir>
```

## Layout

- `packages/shared` — canonical JSON, fake clock, seeded RNG, transcript sink
- `packages/session-core` — event/grant/transcript schemas and runtime guards (types only)
- `packages/eval-harness` — task workflow, Jev grader, evaluation harness core
- `tools/eval-harness-cli` — CLI for runs, comparisons and task validation
- `tools/agent-harness-bench` — agent-harness overhead benchmarks (bench project)
- `evals/` — tasks, golden sets, rubrics, baselines, results, schemas
- `infra/livekit-soak` — isolated LiveKit compatibility spike (D8)

Plans live in Notion, not in git. See `AGENTS.md` for the working rules, the
layout conventions and the decisions already made.
