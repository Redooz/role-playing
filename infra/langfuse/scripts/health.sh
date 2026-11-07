#!/usr/bin/env bash
# Check the Langfuse web health endpoint and the compose service status.
# Run from the Docker host (`infra/langfuse/`) or through scripts/langfuse.sh.
set -euo pipefail

cd "$(dirname "$0")/.."

DOCKER="${DOCKER:-docker}"
if ! command -v "$DOCKER" >/dev/null 2>&1; then
  if [ -x /Applications/Docker.app/Contents/Resources/bin/docker ]; then
    DOCKER=/Applications/Docker.app/Contents/Resources/bin/docker
  else
    echo "docker CLI not found" >&2
    exit 2
  fi
fi

status=0

if curl -fsS --max-time 10 http://127.0.0.1:3000/api/public/health; then
  echo
else
  echo "health: not reachable at http://127.0.0.1:3000/api/public/health" >&2
  status=1
fi

echo "services:"
"$DOCKER" compose ps

unhealthy=$("$DOCKER" compose ps --format json 2>/dev/null | grep -c '"Health":"unhealthy"' || true)
if [ "$unhealthy" != "0" ]; then
  echo "health: $unhealthy unhealthy service(s)" >&2
  status=1
fi

exit "$status"
