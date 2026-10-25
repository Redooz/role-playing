# Role-playing

Voice role-play platform for practising workplace English and French. Several AI
characters talk with one user in real time, and every change that affects
behaviour is checked by evals before it is accepted.

The repo is at milestone **M0** (build the eval foundation). There is no
application code and no audio path yet.

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

npm run validate:fixtures   # fixture/golden validator (gate G3)
npm run evals -- run --manifest evals/manifests/m0-canned-replay.json
npm run evals -- compare --baseline evals/baselines/m0-canned-replay.json --run <run dir>
```

## Layout

- `packages/shared` — canonical JSON, fake clock, seeded RNG, trace sink
- `packages/session-core` — event/grant/trace schemas and runtime guards (types only)
- `packages/eval-engine` — fixture workflow, Jev scorer, eval runner core
- `tools/eval-runner` — CLI for runs, comparisons and fixture validation
- `tools/latency-harness` — harness-overhead benchmarks (bench project)
- `evals/` — fixtures, golden sets, rubrics, baselines, results, schemas
- `infra/livekit-soak` — isolated LiveKit compatibility spike (D8)

Plans live in Notion, not in git. See `AGENTS.md` for the working rules, the
layout conventions and the decisions already made.
