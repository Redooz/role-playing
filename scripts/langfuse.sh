#!/usr/bin/env bash
# Lifecycle for the self-hosted Langfuse review layer (M0.1).
#
# Langfuse runs on a Docker host reachable over SSH (default: the `mac` host in
# ~/.ssh/config). This wrapper copies `infra/langfuse/` there, generates the
# server `.env` on that host, starts the stack, and writes the client values
# into the repository's git-ignored `.env`.
#
#   scripts/langfuse.sh deploy    copy, generate .env, start, wait, sync client env
#   scripts/langfuse.sh up        start the stack
#   scripts/langfuse.sh down      stop the stack (volumes survive)
#   scripts/langfuse.sh logs      follow logs
#   scripts/langfuse.sh health    check the health endpoint and service status
#   scripts/langfuse.sh tunnel    open a local SSH tunnel to the UI/API
#   scripts/langfuse.sh untunnel  close the tunnel
#   scripts/langfuse.sh env       re-sync client values into the repo `.env`
#
# Environment:
#   LANGFUSE_SSH_HOST   SSH host alias (default: mac)
#   LANGFUSE_REMOTE_DIR remote directory under $HOME (default: langfuse)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_DIR="$REPO_ROOT/infra/langfuse"
HOST="${LANGFUSE_SSH_HOST:-mac}"
REMOTE_DIR="${LANGFUSE_REMOTE_DIR:-langfuse}"
CONTROL_PATH="${TMPDIR:-/tmp}/langfuse-ssh-${HOST//[^A-Za-z0-9_.-]/_}.sock"
HEALTH_URL="http://127.0.0.1:3000/api/public/health"

remote() {
  local command="$1"
  ssh -o ClearAllForwardings=yes "$HOST" \
    "export PATH=/Applications/Docker.app/Contents/Resources/bin:/usr/local/bin:\$PATH; cd \"\$HOME/$REMOTE_DIR\" && $command"
}

usage() {
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
}

wait_for_health() {
  local attempts="${1:-60}"
  local index=0
  while [ "$index" -lt "$attempts" ]; do
    if ssh -o ClearAllForwardings=yes "$HOST" "curl -fsS --max-time 5 '$HEALTH_URL' >/dev/null 2>&1"; then
      return 0
    fi
    index=$((index + 1))
    sleep 3
  done
  return 1
}

sync_client_env() {
  local public_key secret_key project_id
  public_key="$(remote 'grep -E "^LANGFUSE_INIT_PROJECT_PUBLIC_KEY=" .env | cut -d= -f2-')"
  secret_key="$(remote 'grep -E "^LANGFUSE_INIT_PROJECT_SECRET_KEY=" .env | cut -d= -f2-')"
  project_id="$(remote 'grep -E "^LANGFUSE_INIT_PROJECT_ID=" .env | cut -d= -f2-')"

  if [ -z "$public_key" ] || [ -z "$secret_key" ]; then
    echo "could not read the project keys from the remote .env" >&2
    return 1
  fi

  local env_file="$REPO_ROOT/.env"
  local temp_file
  temp_file="$(mktemp)"
  if [ -f "$env_file" ]; then
    grep -vE '^(LANGFUSE_ENABLED|LANGFUSE_BASE_URL|LANGFUSE_PUBLIC_KEY|LANGFUSE_SECRET_KEY|LANGFUSE_PROJECT_ID)=' "$env_file" >"$temp_file" || true
  fi
  {
    echo 'LANGFUSE_ENABLED=false'
    echo 'LANGFUSE_BASE_URL=http://127.0.0.1:3000'
    echo "LANGFUSE_PUBLIC_KEY=$public_key"
    echo "LANGFUSE_SECRET_KEY=$secret_key"
    echo "LANGFUSE_PROJECT_ID=$project_id"
  } >>"$temp_file"
  mv "$temp_file" "$env_file"
  chmod 600 "$env_file"
  echo "client values written to $env_file (export stays disabled; set LANGFUSE_ENABLED=true)"
}

case "${1:-}" in
  deploy)
    echo "deploying to $HOST:~/$REMOTE_DIR"
    ssh -o ClearAllForwardings=yes "$HOST" "mkdir -p \"\$HOME/$REMOTE_DIR\""
    rsync -az --delete --exclude '.env' --exclude '.git' "$LOCAL_DIR/" "$HOST:$REMOTE_DIR/"
    remote 'chmod +x scripts/*.sh && bash scripts/gen-env.sh'
    remote 'docker compose up -d --remove-orphans'
    if ! wait_for_health 80; then
      echo "stack did not become healthy; recent logs:" >&2
      remote 'docker compose logs --tail=80' >&2 || true
      exit 1
    fi
    echo "langfuse healthy at $HEALTH_URL (on $HOST)"
    sync_client_env
    ;;
  up)
    remote 'docker compose up -d --remove-orphans'
    ;;
  down)
    remote 'docker compose down'
    ;;
  logs)
    remote 'docker compose logs -f --tail=200'
    ;;
  health)
    if curl -fsS --max-time 5 "$HEALTH_URL"; then
      echo
      echo "local tunnel: reachable"
    else
      echo "local tunnel: not reachable (run: npm run langfuse:tunnel)"
    fi
    remote 'bash scripts/health.sh' || true
    ;;
  tunnel)
    # The user's SSH config carries unrelated LocalForward entries that may
    # already be bound locally. Resolve the alias once and open this tunnel from
    # a clean config so only port 3000 is forwarded.
    effective="$(ssh -G "$HOST" 2>/dev/null)"
    tunnel_host="$(printf '%s\n' "$effective" | awk '$1 == "hostname" { print $2; exit }')"
    tunnel_user="$(printf '%s\n' "$effective" | awk '$1 == "user" { print $2; exit }')"
    tunnel_port="$(printf '%s\n' "$effective" | awk '$1 == "port" { print $2; exit }')"
    if [ -z "$tunnel_host" ] || [ -z "$tunnel_user" ]; then
      echo "cannot resolve SSH host \"$HOST\"" >&2
      exit 2
    fi
    ssh -f -N -F /dev/null -o ExitOnForwardFailure=yes \
      -o HostName="$tunnel_host" -o User="$tunnel_user" -o Port="${tunnel_port:-22}" \
      -o ControlMaster=yes -o ControlPath="$CONTROL_PATH" \
      -L 127.0.0.1:3000:127.0.0.1:3000 "$HOST"
    echo "tunnel open: http://127.0.0.1:3000 (control socket $CONTROL_PATH)"
    ;;
  untunnel)
    ssh -O exit -o ControlPath="$CONTROL_PATH" "$HOST" 2>/dev/null || true
    echo "tunnel closed"
    ;;
  env)
    sync_client_env
    ;;
  help | --help | -h | '')
    usage
    ;;
  *)
    echo "unknown command: $1" >&2
    usage >&2
    exit 2
    ;;
esac
