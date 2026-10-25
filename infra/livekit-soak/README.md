# M0 LiveKit soak spike (D8)

Isolated compatibility probe from the M0 plan (§1.4, D8, gate G6). It runs
publish/subscribe/dispose cycles against a local `livekit-server` and records:

- whether every cycle connected, published and subscribed
- crash / handle-leak behaviour (active handles and active resources per sample)
- RSS slope over the cycle (least-squares, bytes per minute)
- reconnect and disconnect counts
- how long disposal took

It imports **nothing** from `session-core`, `eval-engine` or the apps. There is
no production audio path in M0, and this script must stay that way.

## Run it

Start the server:

```sh
docker run --rm --name rp-livekit-soak \
  -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
  livekit/livekit-server:latest --dev --bind 0.0.0.0
```

Then, from the repo root:

```sh
node infra/livekit-soak/soak.ts
```

The defaults are the M0 gate: 10 cycles of 20 minutes. Override for a smoke
run:

```sh
SOAK_CYCLES=2 SOAK_CYCLE_MINUTES=0.25 SOAK_SAMPLE_SECONDS=5 node infra/livekit-soak/soak.ts
```

`--dev` mode uses the placeholder credentials `devkey` / `secret`, which the
script also defaults to. Nothing here touches cloud LiveKit or any secret.

## Output

Raw metrics are written to `evals/results/m0-livekit-soak/<runId>.json`
(git-ignored). The accepted run is summarised on the Notion page
`m0-livekit-soak`, per the M0 plan.

The report is rewritten after every cycle, so an interrupted run still leaves
partial metrics with `"interrupted": true`.
