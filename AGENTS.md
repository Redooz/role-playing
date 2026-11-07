# AGENTS.md

## What this project is

A voice role-play platform for practicing workplace English and French. Several AI characters talk with one user in real time. The work is built test-first: every change that affects behavior must be checked by evals before it is accepted.

**M0** (the eval foundation) and **M0.1** (the self-hosted Langfuse review
layer) are complete. **M1** (single-agent text) is in progress: the session
driver, the line CLI, the session log and the Groq text adapter exist. Do not
invent commands, folders, or build steps that do not exist.

## Eval vocabulary

Use these words in code, data, docs, and conversation. Do not fall back to the
old synonyms (fixture, repetition, scorer, trace).

- **Evaluation suite** — a collection of related tasks that measures specific
  behaviour, for example `m0-canned-replay`.
- **Capability eval** — asks what the agent can do well. It must show a real
  improvement on its target (a positive minimum detectable effect). New
  behaviour enters here.
- **Regression eval** — asks whether the agent still handles every task it used
  to. Its primary axis is held at the baseline, no improvement is required, and
  every axis is a non-regression gate. Existing behaviour is protected here.
- **Task** — one test: its inputs and the success criteria the suite registers
  for it. Task files live under `evals/tasks/`.
- **Trial** — one attempt at one task. In M0 a trial is one replay of one task.
- **Round** — one pass over every task in a suite. `rounds × tasks = trials`.
- **Grader** — the logic that scores an aspect of a trial. There are three
  types, and they are not interchangeable:
  - **code-based** — deterministic checks, counts, ratios, invariants;
  - **system-1-model-based** — a System One model (Jev) answers a typed question
    and returns a calibrated probability;
  - **human-based** — an annotator's label, used as the reference the other two
    are checked against.
- **Transcript** — the complete record of a trial: outputs, tool calls,
  reasoning, and every interaction, each with a content class.
- **Outcome** — the final state of the environment after a trial, for example
  whether a booking exists in the database. M0 has no environment, so it has no
  outcome checks; the current `invariants` are transcript checks.
- **Evaluation harness** — the infrastructure that runs evals
  (`packages/eval-harness`, `tools/eval-harness-cli`).
- **Agent harness** — the system that lets a model act: the session engine, its
  tools, and its transport. It arrives in M1+; `packages/session-core` holds the
  schemas it will use.

## Where the plan lives

- The plan lives in Notion under the page **Role-Playing**:
  - Architecture Plan v5 — `40383d257ddf81d183c7c74e2806749a`
  - M0 Plan: Eval Foundation — `40383d257ddf818eb796e4761f285209`
  - M0.1 Plan: Langfuse Review Layer — `41183d257ddf81bc9c41e6464a643407`
  - M1 Plan: Single-Agent Text — `41183d257ddf81ba8e0ffccae64d3e0e`
- Local copies sit in `docs/plans/` (git-ignored): `architecture-plan-v5.md`,
  `m0-plan-eval-foundation.md`, `m0.1-plan-langfuse-review-layer.md`,
  `m1-plan-single-agent-text.md`. Read those first; only call Notion when they
  are stale.
- Reading notes sit beside them as `docs/plans/reading-notes-*.md`. They record
  the evidence behind eval, latency and reliability decisions. They are not
  plans, and they do not override the current milestone plan.
- `docs/` is git-ignored on purpose. Never add doc files back to git.
- Before starting work, read the current milestone plan and the architecture plan. They contain the current task list and the rules below.

## Notion access

- There are no MCP servers configured. Do not add any.
- Use the Notion CLI `ntn` (already logged in) instead of an MCP or the API by hand.
- Refresh a plan copy with `ntn pages get <page-id> > docs/plans/<file>.md`.
- Search pages with `ntn api /v1/search -d '{"query":"..."}'`.
- Never paste a token into a file, log, or shell history; `ntn` uses the login session.

## Decisions already made

- Node 26, npm workspaces, TypeScript, Vitest, Zod, ESLint + Prettier.
- Audio comes later. Build and test with text sessions first.
- Spoken replies stream as plain text. Do not use JSON mode for speech.
- Persona replies use Groq `openai/gpt-oss-20b`. This model is fixed; reviewer tests must not change it.
- The async session reviewer is a separate model, provisional `anthropic/claude-haiku-5.5` (low reasoning).
- Semantic grading uses Jev, pinned to `typesafe/jev-1.14`. Never use `jev-latest`.
- Use OpenRouter for Jev and eval models. A ChatGPT subscription does not work at runtime.
- Live speech-to-text is Azure `MAI-Transcribe-2-Streaming`.

## Code layout

- Split code by layer: `domain/`, `adapters/`. Do not create a `features/` folder or an `application/` folder.
- `domain/` holds entities, value objects, domain rules, and the ports in `domain/ports/`.
- Use cases live in `domain/usecases/`, one per action: `<verb>-<noun>.usecase.ts`. They are plain code with the business rules. No HTTP, LiveKit, database, or provider imports.
- Tests live next to the file under test, at the same level, with a `.spec.ts` name. Example: `create-user.usecase.spec.ts` next to `create-user.usecase.ts`. Do not use a separate `test/` folder.
- `adapters/inbound/` holds `<action>.controller.ts` and `<action>.handler.ts`. Controllers only translate requests. Handlers check identity and input, then call one use case.
- `adapters/outbound/` holds database, provider, and storage adapters, named like `user.postgres.adapter.ts`.
- `mappers/` is optional. Add a mapper only when two shapes differ.
- Never add `*.service.ts`, a `services/` folder, a `features/` folder, or an `application/` folder.
- Depend inward: controller → handler → use case → port. An adapter may not import a use case, and a use case may not import an adapter.
- Wire real adapters once per app in the composition root. Tests use fake or canned adapters.
- Libraries (`session-core`, `turn-arbiter`, `routing-policy`, `eval-harness`) expose functions and ports. They do not get controllers or handlers.
- Observability follows the same rule: `packages/eval-harness/src/observability/` holds the pure plan, grade sidecar and observer port; `tools/eval-harness-cli/src/adapters/langfuse.adapter.ts` is the only file that imports Langfuse or OpenTelemetry.

## Rules that are easy to get wrong

- **Evals decide.** If an eval gets worse, fix the feature. Never lower a threshold or widen a gate to make a change pass.
- **Name the purpose.** A new behaviour needs a capability eval. Existing behaviour needs a regression eval. A capability result is not proof that old tasks still pass.
- **Each trial starts clean.** Every trial gets its own clock, RNG stream, provider instance, and copy of the task. Dispose per-trial resources in `finally`. A failed trial must not change the next trial.
- **Models grade, code decides.** Counting, math, dates, and hard limits stay in normal code. Ask Jev only for yes/no or graded answers.
- **Store raw scores.** Keep the full Jev answer and probability, not just the chosen label.
- **A failed model call is not a "no".** Mark the run incomplete; never turn an error into a pass or zero.
- **One writer at a time.** Only the character that holds the current turn may produce output. Late output from an old turn is dropped.
- **No secret in the repo.** API keys stay in the environment (they are loaded from `~/.bashrc`). Never put keys in files, logs, or transcripts. The self-hosted Langfuse server `.env` stays on the Docker host and is git-ignored; only the client keys reach the repository's `.env`.
- **No raw audio saved by default.** Saving audio needs a separate opt-in from the user.
- **Langfuse observes; code decides.** The self-hosted Langfuse instance is the review layer for transcripts, scores and experiment comparison. It never replaces the manifest, the verdict, the baselines, the Jev client or the golden files. There is no custom transcript viewer, grade table, comparison dashboard or results web UI.
- **Export never changes a verdict.** Langfuse export is opt-in (`LANGFUSE_ENABLED=true`) and runs after `result.json`, the transcripts and `grades.jsonl` are written. A failed export only fails the command when `--require-export` is set. Self-hosted only: never point `LANGFUSE_BASE_URL` at Langfuse Cloud.

## Known trial-isolation gaps (M0 → M1)

M0 isolates in-memory trial state only: clock, RNG, provider instance, and task
copy. These are **not** implemented yet and must arrive with the agent harness:

- a process, worker, or container boundary per trial;
- a per-trial timeout and cancellation path for a hung provider or tool;
- reset and seeding of an external database;
- a per-trial filesystem workspace and cleanup of its temporary files;
- reset of environment variables, network mocks, and module-level caches;
- verified cleanup of live provider connections and background work.

Do not claim a trial is isolated until every external state it touches has a
reset path covered by a test.

## Working style

- **Always work on a feature branch, never on `main`.** Name it `<type>/<short-slug>` with the same
  prefixes the commits use (`feat/`, `fix/`, `refactor/`, `docs/`, `chore/`, `ci/`), for example
  `feat/m1-session-driver` or `fix/cancel-late-chunk`. Open it before the first edit, keep one
  concern per branch, and let CI run before merging. If a change lands on `main` by mistake, move
  it to a branch and reset `main`; do not build on top of it.
- Keep changes small and tied to one milestone.
- Do not start audio work before M5.
- Use separate English and French test data. Passing in one language does not count for the other.
- When the plan and the code disagree, trust the code, then update the plan in Notion.
