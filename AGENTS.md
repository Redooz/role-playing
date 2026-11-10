# AGENTS.md

## What this project is

A voice role-play platform for practising workplace English and French. Several
AI characters talk with one user in real time. Every change that affects
behaviour must be checked by evals before it is accepted.

**M0** (eval foundation) and **M0.1** (self-hosted Langfuse review layer) are
complete. **M1** (single-agent text) is complete: the transport-agnostic session
driver, line CLI, append-only session log, Groq text adapter, trial isolation and
mutation floor exist. **M2** (personas and scenarios) implements versioned
persona/scenario data, BCP 47 locale variants, the two-bucket persona prompt, a
greeting-first driver, the plain-text output hook, a live session runner, the Jev
axial grader and `pass^k` reporting. M2 is complete and merged. M2 acceptance is
recorded in `evals/decisions.md`; the accepted runs are promoted to
`evals/baselines/m2-persona-*.json`. The default persona model is LiveKit Gemma
`google/gemma-4-31b-it`, semantic grading needs OpenRouter, and the Gemma live
gate needs `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`. There is no audio path yet.
Do not invent commands, folders or build steps that do not exist.

## Start with the plan

- Read `docs/plans/architecture-plan-v5.md` and the current milestone plan
  before changing behaviour. `docs/` is git-ignored on purpose; never add it
  back to git.
- The source of truth is Notion under the page **Role-Playing**:
  - Architecture Plan v5 — `40383d257ddf81d183c7c74e2806749a`
  - M0 Plan: Eval Foundation — `40383d257ddf818eb796e4761f285209`
  - M0.1 Plan: Langfuse Review Layer — `41183d257ddf81bc9c41e6464a643407`
  - M1 Plan: Single-Agent Text — `41183d257ddf81ba8e0ffccae64d3e0e`
  - M2 Plan: Personas and Scenarios — `41283d257ddf8186a092fdf50b9bae4b`
- Local plan copies live in `docs/plans/`. Refresh one with
  `ntn pages get <page-id> > docs/plans/<file>.md`; search with
  `ntn api /v1/search -d '{"query":"..."}'`.
- There are no MCP servers configured. Do not add any. Never put a token in a
  file, log or shell history; `ntn` uses its login session.
- The one pinned skill is `.agents/skills/typesafe-ai/SKILL.md` (hash in
  `skills-lock.json`); use it for Jev question design.

## Commands

```sh
npm install
npm run lint             # ESLint
npm run format:check     # Prettier; `npm run format` writes
npm run typecheck        # tsc -b; same command as `npm run build`
npm run test:unit        # fast suite, the PR gate (alias: npm test)
npm run test:bench       # wall-time measurements, never the PR gate
# LATENCY_PROVIDER=groq|openrouter|livekit, LATENCY_MODEL=<id>
LATENCY_PROVIDER=livekit LATENCY_MODEL=google/gemma-4-31b-it npm run test:bench -- tools/agent-harness-bench/src/session-latency.bench.spec.ts
npm run mutation         # Stryker + per-package floor check; not a PR gate

# One test file or one package
npx vitest run --project unit packages/session-core/src/driver.spec.ts

# Text session CLI; canned mode needs no key
npm run chat -- --provider canned
npm run chat -- --provider live --lang fr --persona manager --scenario request-deadline-extension
npm run chat -- --provider canned --locale en-GB   # locale variant probe

npm run validate:tasks   # task/golden validator (gate G3)
npm run label:export -- --lang en --run evals/results/m2-persona-scenarios-lk --run evals/results/m2-persona-baseline-lk
npm run eval -- run --manifest evals/manifests/m0-canned-replay.json
npm run eval -- run --manifest evals/manifests/m2-persona-replay-v2.json
npm run eval -- run --manifest evals/manifests/m2-persona-baseline-lk-v4.json   # pre-registered generic baseline; accepted baseline is -lk-v3
npm run eval -- run --manifest evals/manifests/m2-persona-scenarios-lk-v5.json  # accepted Gemma capability
npm run eval -- run --manifest evals/manifests/m2-persona-baseline.json      # historical Groq baseline
npm run eval -- run --manifest evals/manifests/m2-persona-scenarios.json     # historical Groq capability
npm run eval -- run --manifest evals/manifests/m2-locale-variants.json       # historical Groq locale probe
npm run eval -- compare --baseline evals/baselines/m0-canned-replay.json --run <run-dir>

# Self-hosted Langfuse review layer (M0.1)
npm run langfuse:deploy   # copy infra/langfuse to the Docker host, start, sync keys
npm run langfuse:health
npm run langfuse:tunnel   # forward localhost:3000 to the Docker host
npm run langfuse:verify   # check an exported run against the Langfuse API
npm run langfuse:down
```

CI runs `lint -> format:check -> typecheck -> test:unit`, plus separate task
validator and Jev-canary jobs. The canary is skipped when
`OPENROUTER_API_KEY` is absent.

## Repository map

- `packages/shared` — clock, seeded RNG, canonical JSON, transcript sink, BCP 47
  locale helpers and the pure plain-text speech filter.
- `packages/session-core` — event/grant/transcript schemas, runtime guards, the
  `SessionDriver` port with greeting/locale support, and append-only session-log
  codec. This is the product seam; keep it transport- and provider-agnostic.
- `packages/scenario-kit` — versioned `ScenarioSpec`/`ScriptedUserSpec` data with
  `en`, `fr`, `en-GB` and `fr-CA` variants.
- `packages/persona-kit` — versioned `PersonaSpec` data, three personas with
  localized variants, and the pure two-bucket prompt builder.
- `packages/pipeline` — model adapters implementing `TextModelPort`: LiveKit
  Inference (Gemma default), Groq persona streaming (historical), OpenRouter,
  and the streaming plain-text decorator. Base URLs are constructor options;
  the composition roots read `GROQ_BASE_URL`, `OPENROUTER_BASE_URL` and
  `LIVEKIT_INFERENCE_URL` from the environment.
- `packages/eval-harness` — task workflow, Jev axial grader, replay and live
  session runners, `pass^k`, verdicts, and the observation plan/grade sidecar.
- `tools/eval-harness-cli` — eval run/compare/validate CLI. It builds the live
  provider (Groq, OpenRouter or LiveKit Inference) and Jev grader from the
  environment. The only place that imports Langfuse or OpenTelemetry is
  `src/adapters/langfuse.adapter.ts`.
- `tools/annotation-kit` — context-free double-annotation kit for Langfuse
  queues (`build-bundle.mjs`, `annotate.mjs`, `analyze-agreement.mjs`). Keep
  scores, model names and candidate/baseline labels out of annotator bundles;
  the trace→run manifest stays operator-only.
- `apps/cli` — composition root for the line CLI. `main.ts` reads env, selects
  persona/scenario/locale, builds the prompt and starts the driver; `cli-main.ts`
  is the REPL and holds no session state.
- `tools/agent-harness-bench` — overhead and latency benches (`*.bench.spec.ts`).
- `infra/livekit-soak` — isolated LiveKit compatibility spike. It imports nothing
  from the session or eval code; keep it that way.

`apps/api`, `apps/web`, `apps/orchestrator`, `packages/feedback-worker`,
`packages/routing-policy`, `packages/turn-arbiter` and `tools/routing-bench` are
intentional `.gitkeep` placeholders. Do not fill them with speculative code.

## Non-obvious mechanics

- Node 26 strips types, so `npm run chat` and `npm run eval` run `.ts` source
  directly; no build is required. Relative imports still use `.js` specifiers
  under `module: nodenext` even though the files are `.ts`. New entrypoints must
  register the same `.js` → `.ts` resolve hook as `apps/cli/src/cli.ts`.
- The built packages export `./src/index.ts`. `dist/` is tsc output, not what the
  scripts or workspace imports use.
- Tests sit next to the file under test and end in `.spec.ts`; there is no
  `test/` folder. `*.bench.spec.ts` files run only in the `bench` project.
- `.env` is loaded only by npm scripts via `--env-file-if-exists=.env`. Do not
  add a dotenv dependency. Unit tests inject `fetch`; they must not need live
  keys.
- `evals/schemas/*.json` are generated from Zod, never hand-edited. Regenerate
  after changing `packages/eval-harness/src/tasks/schema.ts`:
  `UPDATE_SCHEMAS=1 npx vitest run packages/eval-harness/src/tasks/schema.spec.ts`
  then `npx prettier --write evals/schemas`.
- The eval CLI refuses to overwrite `evals/results/<runId>/`; pass
  `--results-root <dir>` to keep a second run of the same manifest. `runId` is
  the manifest's suite id, not a unique run id.
- For new app actions, Architecture Plan §1.5 requires
  `domain/{ports,usecases}` plus `adapters/{inbound,outbound}`, an optional
  `mappers/` folder, and one composition root. Never add `services/`,
  `features/`, `application/`, or `*.service.ts`. Libraries expose plain
  functions and ports, not controllers or handlers.

## Eval vocabulary

Use these words. Do not substitute fixture, repetition, scorer, or trace.

- **Evaluation suite** — related tasks measured by one manifest, for example
  `m0-canned-replay`.
- **Task** — one test with inputs and success criteria under `evals/tasks/`.
- **Trial** — one attempt at one task. **Round** — one pass over every task;
  `rounds × tasks = trials`.
- **Evaluation harness** — `packages/eval-harness` plus
  `tools/eval-harness-cli`; the **agent harness** is the session engine, its
  tools and its transport.
- **Capability eval** — new behaviour; its target must show a positive minimum
  detectable effect. **Regression eval** — existing behaviour; every axis is a
  non-regression gate.
- **Grader** — `code` (deterministic counts/invariants),
  `system-one-model` (Jev's calibrated probability), or `human` (reference
  labels). The three are not interchangeable.
- **Transcript** — the complete trial record with a content class. **Outcome** —
  the environment state after a trial.

## Rules that are easy to get wrong

- **Evals decide.** If an eval regresses, fix the feature. Never lower a
  threshold, widen a gate, or edit a manifest/baseline to make a change pass.
- **Name the purpose.** New behaviour needs a capability eval; existing behaviour
  needs a regression eval. One does not prove the other.
- **Each trial starts clean.** Per-trial clock, RNG stream, provider instance,
  task copy and environment snapshot; dispose in `finally`. A failed trial must
  not change the next one.
- **Models grade, code decides.** Counting, maths, dates and hard limits stay in
  normal code. Ask Jev only yes/no or graded questions, and store the raw answer
  and probability, not just the label.
- **An LLM annotation pass is not human ground truth.** The annotation-kit
  passes were run with OpenCode, not a System One model. They prefill and triage
  only. Only blind human double-labelling can make a semantic gate `stable`;
  LLM labels keep it provisional.
- **A failed model call is not a "no".** Mark the run incomplete; never turn an
  error into a pass or zero.
- **One writer at a time.** Only the character holding the current turn may
  produce output; late output from an old turn is dropped.
- **No secret in the repo.** Keys stay in the environment or the git-ignored
  `.env`. Never put them in files, logs or transcripts. The Langfuse server
  `.env` stays on the Docker host.
- **No raw audio by default.** Saving audio needs explicit opt-in from the user.
- **Langfuse observes; code decides.** It never replaces the manifest, verdict,
  baselines, Jev client or golden files. There is no custom transcript viewer,
  grade table, comparison dashboard or results web UI.
- **Export never changes a verdict.** Export is opt-in (`LANGFUSE_ENABLED=true`)
  and runs after `result.json`, transcripts and `grades.jsonl` are written.
  `--require-export` exits 3 after artifacts; self-hosted only, never Cloud.
- **Fixed models.** Persona replies use LiveKit Inference
  `google/gemma-4-31b-it` with the `gemma` prompt family and stream as plain
  text; do not use JSON mode for speech. Groq `openai/gpt-oss-20b` remains the
  historical pinned path: its manifests and results are kept as reference but
  no longer drive the product default. Semantic grading uses Jev pinned to
  `typesafe/jev-1.14` (never `jev-latest`) through OpenRouter; a ChatGPT
  subscription cannot be used at runtime. The provisional async reviewer is
  `anthropic/claude-haiku-5.5`. The live STT choice is Azure
  `MAI-Transcribe-2-Streaming`. `openrouter/openai/gpt-oss-safeguard-20b` is a
  retired probe. The `gemma` semantic gate is provisional on agent labels by
  project choice; only blind human double-labelling could make it `stable`.
- **Separate English and French data.** Passing in one language does not count
  for the other. Audio work does not start before M5.
- **Locale is not a language.** Keep `lang: 'en' | 'fr'` for routing, task paths
  and Jev. `locale` is a canonical BCP 47 tag (`en`, `fr`, `en-GB`, `fr-CA`); use
  `en-GB`, never `en-UK`. A missing locale variant is a hard error, never a
  fallback.
- **Plain text is enforced, not requested.** Wrap every persona model with
  `createPersonaTextModel`. The prompt asks for plain text, the streaming hook
  removes Markdown and emoji, and the `response.plain_text` invariant proves it.
  Empty-after-filtering is a policy violation, not an outage and not a pass.
- **M2 stays single-speaker.** Personas are `manager`, `peer` and `client`; no
  second speaker, routing, extraction or audio.

## Trial isolation: current state

Implemented and covered by tests:

- per-trial clock, RNG stream, provider instance, task copy and environment
  snapshot;
- wall-clock timeout plus cancellation (`withTrialTimeout`), a bounded stop
  grace window, and late provider rejections that do not become unhandled;
- `dispose()` in `finally` on success, provider failure and timeout;
- interleaved-trial tests for instance identity, timer/socket teardown and the
  absence of unhandled rejections.

Still gaps — do not claim a trial is fully isolated until each has a reset path
covered by a test:

- a process, worker or container boundary per trial;
- external database reset and seeding;
- a per-trial filesystem workspace and temp-file cleanup;
- network mocks and module-level cache reset;
- live-provider teardown against a real provider. The socket test uses a local
  server; Groq/OpenRouter are tested with an injected `fetch`.

## Mutation and eval artifacts

- `npm run mutation` scores the behaviour-bearing files listed in
  `stryker.config.json` (session-core, pipeline, persona-kit prompt/lookup,
  scenario-kit lookup/helpers, shared locale/plain-text, apps/cli), then checks
  each package against `evals/baselines/m1-mutation.json`. The global break
  threshold is 95. Timed-out mutants count as killed; runtime/compile errors are
  excluded. Never lower the floor or hand-edit the baseline. Record a new
  baseline only with `npm run mutation:record` after a clean `npm run mutation`.
- `evals/results/` is git-ignored except the curated `index.md`. Promote an
  accepted run by copying its `result.json` into `evals/baselines/<suite>.json`
  and running Prettier. Record the decision in `evals/decisions.md` and the run
  index.
- Langfuse runs on a Docker host over SSH (default alias `mac`, override with
  `LANGFUSE_SSH_HOST`). `langfuse:deploy` writes client keys to the git-ignored
  root `.env` and leaves `LANGFUSE_ENABLED=false`.

## Working style

- **Always work on a feature branch, never `main`.** Use
  `<type>/<short-slug>` with `feat/`, `fix/`, `refactor/`, `docs/`, `chore/` or
  `ci/`. Open it before the first edit, keep one concern per branch, and let CI
  run before merging. If a change lands on `main` by mistake, move it to a branch
  and reset `main`; do not build on it.
- Keep changes small and tied to one milestone.
- The `opencode review` workflow reviews a PR against `AGENTS.md` from the base
  branch, so a PR cannot relax its own review rules; changes to this file take
  effect after merge.
- When the plan and the code disagree, trust the code, then update the plan in
  Notion.
