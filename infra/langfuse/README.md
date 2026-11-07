# Self-hosted Langfuse (M0.1)

The review layer for eval runs. Langfuse **observes and displays** trial traces,
per-axis scores and experiment comparisons. The evaluation harness still replays,
grades and decides.

- Langfuse `4.76.0` (web and worker), ClickHouse `26.3.62.3`, Postgres `17.6`,
  Redis `7.4.5`, MinIO pinned by digest.
- `langfuse-web`, `langfuse-worker`, Postgres, ClickHouse, Redis and MinIO only.
  The AI gateway and in-app agent are deliberately not deployed.
- Only the web UI is published, on `127.0.0.1:3000`. Databases and MinIO stay on
  the internal Docker network. Reach the UI from another machine through an SSH
  tunnel.

## Run it

From the repository root:

```sh
npm run langfuse:deploy   # copy this directory to the Docker host, generate .env, start, sync keys
npm run langfuse:health   # health endpoint + compose status
npm run langfuse:tunnel   # localhost:3000 -> Docker host 127.0.0.1:3000
npm run langfuse:verify   # check a run's langfuse.json against the API
npm run langfuse:down
```

The default SSH host alias is `mac`; override with `LANGFUSE_SSH_HOST`. The
remote directory defaults to `~/langfuse`; override with `LANGFUSE_REMOTE_DIR`.

On the host, the same lifecycle is:

```sh
cd ~/langfuse
docker compose up -d
docker compose ps
docker compose logs -f --tail=200
docker compose down
```

## Configuration

`scripts/gen-env.sh` writes `.env` on the Docker host with fresh random secrets
and the headless-init values. It refuses to overwrite an existing `.env`:
rotating secrets against an initialised database would lock out the project.

The client values (`LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`,
`LANGFUSE_SECRET_KEY`, `LANGFUSE_PROJECT_ID`) are copied into the repository's
git-ignored `.env` by `npm run langfuse:deploy`. Export stays off until
`LANGFUSE_ENABLED=true` is set.

Headless initialization creates the organization, project, user and API keys on
first boot. It only runs against an empty database.

## Resources

ClickHouse is the heavy component. Budget roughly 4 CPU cores, 8–16 GB RAM and
10 GB of local disk for the stack. The current deployment runs in an 8 GB Docker
VM on a 16 GB Apple Silicon host and is healthy for eval-sized workloads.

## Upgrade and backup

The compose file has no high-availability or backup functionality; that matches
the upstream Docker Compose deployment.

1. Run `docker compose down` so no writes are in flight.
2. Snapshot the named volumes (`langfuse_postgres_data`,
   `langfuse_clickhouse_data`, `langfuse_clickhouse_logs`,
   `langfuse_minio_data`, `langfuse_redis_data`). For a logical Postgres backup:
   `docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > langfuse.sql`.
3. Change `LANGFUSE_IMAGE_TAG` to the new pinned release, then
   `docker compose pull && docker compose up -d`. Web runs migrations on start.
4. Run `npm run langfuse:health` and export one known run to verify.

To start over, `docker compose down -v` **deletes all Langfuse data** and the
next boot recreates the headless-init project with the same keys.

## Privacy

- Self-hosted only. The exporter refuses any `langfuse.com` hostname.
- Transcripts are `restricted`: they stay on local infrastructure. There is no
  Langfuse Cloud, no hosted dataset sync, and no raw audio.
- The server `.env` never leaves the Docker host. Do not commit it.
