# Role-playing

Voice role-play platform for practising workplace English and French. Several AI
characters talk with one user in real time, and every change that affects
behaviour is checked by evals before it is accepted.

M0 (the eval foundation) and M0.1 (the self-hosted Langfuse review layer) are
complete. **M1** (single-agent text) is complete. **M2** (personas and scenarios)
adds versioned persona/scenario data with `en`/`fr`/`en-GB`/`fr-CA` variants, the
two-bucket prompt, greeting-first sessions, the plain-text output hook, a live
session runner, the Jev axial grader and `pass^k` reporting. Gates M1-G1–G6 are
recorded in `evals/decisions.md`. The default persona model is LiveKit Gemma
`google/gemma-4-31b-it`; the Gemma live gate needs
`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` and semantic grading needs OpenRouter.
The semantic axes stay provisional until human agreement is measured. There is
no audio path yet.

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
- **Review layer** — the self-hosted Langfuse instance that displays trial
  traces, per-axis scores and experiment comparisons. It observes; the harness
  still replays, grades and decides. There is no custom transcript viewer, grade
  table, comparison dashboard or results web UI.
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
# Latency probe: LATENCY_PROVIDER=groq|openrouter|livekit, LATENCY_MODEL=<id>
LATENCY_PROVIDER=livekit LATENCY_MODEL=google/gemma-4-31b-it npm run test:bench -- tools/agent-harness-bench/src/session-latency.bench.spec.ts
npm run mutation        # Stryker over packages/session-core (not a PR gate yet)

# Text session CLI (M2). Live mode needs LIVEKIT_API_KEY/LIVEKIT_API_SECRET in .env.
npm run chat -- --provider canned
npm run chat -- --provider canned --locale en-GB --persona peer --scenario clarify-task-in-standup
npm run chat -- --provider live --persona manager --scenario request-deadline-extension

npm run validate:tasks  # task/golden validator (gate G3)
npm run label:export -- --lang en --run evals/results/m2-persona-scenarios-lk --run evals/results/m2-persona-baseline-lk
npm run eval -- run --manifest evals/manifests/m0-canned-replay.json
npm run eval -- run --manifest evals/manifests/m2-persona-replay.json
npm run eval -- run --manifest evals/manifests/m2-persona-baseline-lk.json   # Gemma default baseline
npm run eval -- run --manifest evals/manifests/m2-persona-scenarios-lk.json  # Gemma default capability
npm run eval -- run --manifest evals/manifests/m2-persona-baseline.json      # historical Groq baseline
npm run eval -- run --manifest evals/manifests/m2-persona-scenarios.json     # historical Groq capability
npm run eval -- run --manifest evals/manifests/m2-locale-variants.json       # historical Groq locale probe
npm run eval -- run --manifest evals/manifests/m2-persona-baseline-or.json   # retired OpenRouter probe
npm run eval -- run --manifest evals/manifests/m2-persona-scenarios-or.json  # retired OpenRouter probe
npm run eval -- run --manifest evals/manifests/m2-locale-variants-or.json    # retired OpenRouter locale probe
npm run eval -- compare --baseline evals/baselines/m0-canned-replay.json --run <run dir>

# Self-hosted Langfuse review layer (M0.1)
npm run langfuse:deploy   # copy infra/langfuse to the Docker host, start, sync keys
npm run langfuse:health
npm run langfuse:tunnel   # forward localhost:3000 to the Docker host
npm run langfuse:verify   # check an exported run against the Langfuse API
npm run langfuse:down
```

Provider base URLs are optional `.env` overrides: `GROQ_BASE_URL`,
`OPENROUTER_BASE_URL` and `LIVEKIT_INFERENCE_URL`. The defaults live in the
adapters, so a proxy or gateway can be swapped without a code edit. LiveKit
Inference also needs `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`; its tokens are
minted per request and never stored.

Session prompts come in two versioned families: `gemma` for the default LiveKit
Gemma path and `harmony` for the historical Groq path. The Gemma pack drops the
OpenAI-specific Harmony header and channel vocabulary, writes the instructions
as a direct first-turn preamble (Google's Gemma 3 guidance), and uses plain-text
section labels plus short examples. A manifest names the family and the matching
template version.

## Review layer

Langfuse observes and displays; the harness replays, grades and decides. It runs
from `infra/langfuse/docker-compose.yml` on a Docker host reachable over SSH
(default host alias `mac`, override with `LANGFUSE_SSH_HOST`). Only the web UI
is published, on the host's loopback interface; open an SSH tunnel to reach it.

- The server `.env` is generated on the Docker host by
  `infra/langfuse/scripts/gen-env.sh` and never enters the repository.
- `npm run langfuse:deploy` writes the client values into the git-ignored root
  `.env` and leaves `LANGFUSE_ENABLED=false`.
- A run writes `result.json`, `transcripts/`, `grades.jsonl` and `langfuse.json`.
  `grades.jsonl` is the raw per-trial grade copy; `langfuse.json` records the
  export status, experiment id and trace ids.
- Export is opt-in (`LANGFUSE_ENABLED=true`). `--no-export` forces it off;
  `--require-export` makes a failed export exit 3 **after** every artifact is
  written. Export failure never changes the eval verdict.
- Self-hosted only. The exporter refuses any `langfuse.com` hostname. No custom
  transcript viewer, grade table, comparison dashboard or results web UI exists.

## Layout

- `packages/shared` — canonical JSON, fake clock, seeded RNG, transcript sink,
  BCP 47 locale helpers and the plain-text filter
- `packages/session-core` — event/grant/transcript schemas, runtime guards and the
  greeting-first session driver
- `packages/scenario-kit` — versioned scenarios and scripted users with locale variants
- `packages/persona-kit` — versioned personas and the deterministic prompt builder
- `packages/pipeline` — Groq/OpenRouter/LiveKit text adapters and the plain-text
  stream hook
- `packages/eval-harness` — task workflow, Jev axial grader, replay and live
  session runners, `pass^k`, evaluation harness core, observation plan and grades
- `tools/eval-harness-cli` — CLI for runs, comparisons, task validation and the
  Langfuse adapter
- `tools/agent-harness-bench` — agent-harness overhead benchmarks (bench project)
- `evals/` — tasks, golden sets, rubrics, baselines, results, schemas
- `infra/langfuse` — pinned self-hosted Langfuse stack (Docker Compose)
- `infra/livekit-soak` — isolated LiveKit compatibility spike (D8)

Plans live in Notion, not in git. See `AGENTS.md` for the working rules, the
layout conventions and the decisions already made.
