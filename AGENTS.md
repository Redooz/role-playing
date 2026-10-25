# AGENTS.md

## What this project is

A voice role-play platform for practicing workplace English and French. Several AI characters talk with one user in real time. The work is built test-first: every change that affects behavior must be checked by evals before it is accepted.

The repo has no application code yet. It is at milestone **M0** (build the eval foundation). Do not invent commands, folders, or build steps that do not exist.

## Where the plan lives

- The plan lives in Notion under the page **Role-Playing**:
  - Architecture Plan v5 — `40383d257ddf81d183c7c74e2806749a`
  - M0 Plan: Eval Foundation — `40383d257ddf818eb796e4761f285209`
- Local copies sit in `docs/plans/` (git-ignored): `architecture-plan-v5.md`,
  `m0-plan-eval-foundation.md`. Read those first; only call Notion when they are
  stale.
- `docs/` is git-ignored on purpose. Never add doc files back to git.
- Before starting work, read the M0 plan and the architecture plan. They contain the current task list and the rules below.

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
- Semantic scoring uses Jev, pinned to `typesafe/jev-1.14`. Never use `jev-latest`.
- Use OpenRouter for Jev and eval models. A ChatGPT subscription does not work at runtime.
- Live speech-to-text is Azure `MAI-Transcribe-2-Streaming`.

## Code layout

- Split code by layer: `domain/`, `application/`, `adapters/`. Do not create a `features/` folder.
- `domain/` holds entities, value objects, domain rules, and the ports in `domain/ports/`.
- `application/` holds one use case per action: `<verb>-<noun>.usecase.ts`. Use cases are plain code with the business rules. No HTTP, LiveKit, database, or provider imports.
- `adapters/inbound/` holds `<action>.controller.ts` and `<action>.handler.ts`. Controllers only translate requests. Handlers check identity and input, then call one use case.
- `adapters/outbound/` holds database, provider, and storage adapters, named like `user.postgres.adapter.ts`.
- `mappers/` is optional. Add a mapper only when two shapes differ.
- Never add `*.service.ts`, a `services/` folder, or a `features/` folder.
- Depend inward: controller → handler → use case → port. An adapter may not import a use case, and a use case may not import an adapter.
- Wire real adapters once per app in the composition root. Tests and evals use fake or canned adapters.
- Libraries (`session-core`, `turn-arbiter`, `routing-policy`, `eval-engine`) expose functions and ports. They do not get controllers or handlers.

## Rules that are easy to get wrong

- **Evals decide.** If an eval gets worse, fix the feature. Never lower a threshold or widen a gate to make a change pass.
- **Models judge, code decides.** Counting, math, dates, and hard limits stay in normal code. Ask Jev only for yes/no or graded judgments.
- **Store raw scores.** Keep the full Jev answer and probability, not just the chosen label.
- **A failed model call is not a "no".** Mark the run incomplete; never turn an error into a pass or zero.
- **One writer at a time.** Only the character that holds the current turn may produce output. Late output from an old turn is dropped.
- **No secret in the repo.** API keys stay in the environment (they are loaded from `~/.bashrc`). Never put keys in files, logs, or traces.
- **No raw audio saved by default.** Saving audio needs a separate opt-in from the user.

## Working style

- Keep changes small and tied to one milestone.
- Do not start audio work before M5.
- Use separate English and French test data. Passing in one language does not count for the other.
- When the plan and the code disagree, trust the code, then update the plan in Notion.
