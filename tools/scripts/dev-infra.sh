#!/usr/bin/env bash
# Manage the local development stack.
#   dev-infra.sh up|down|status|reset|logs [service]
# Credentials are generated once into tools/.env (git-ignored). Nothing secret is committed.
set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$TOOLS_DIR/.env"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$TOOLS_DIR/docker-compose.yml")

random() { openssl rand -hex 16; }

ensure_env() {
  if [[ -f "$ENV_FILE" ]]; then return; fi
  umask 077
  cat >"$ENV_FILE" <<ENV
POSTGRES_CORE_PASSWORD=$(random)
POSTGRES_VAULT_PASSWORD=$(random)
REDIS_PASSWORD=$(random)
S3_ACCESS_KEY=$(random)
S3_SECRET_KEY=$(random)
ENV
  echo "Generated local credentials in tools/.env (git-ignored)."
}

require_docker() {
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running or not reachable." >&2
    exit 1
  fi
}

cmd="${1:-up}"
shift || true
require_docker
ensure_env

# Photo buckets for the profile service (ADR-0024). weed shell fails when a bucket already
# exists, so only that error is accepted: repeat runs keep the buckets.
ensure_buckets() {
  local out
  if ! out="$(printf 's3.bucket.create -name photo-uploads\ns3.bucket.create -name photo-media\n' |
    "${COMPOSE[@]}" exec -T s3 weed shell 2>&1)"; then
    if grep -i 'error' <<<"$out" | grep -qv 'already exists'; then
      printf '%s\n' "$out" >&2
      return 1
    fi
  fi
}

case "$cmd" in
  up)
    "${COMPOSE[@]}" up -d --wait --wait-timeout 240
    # Photo buckets for the profile service (ADR-0024). Safe to repeat: existing ones are kept.
    ensure_buckets
    ;;
  down)   "${COMPOSE[@]}" down ;;
  reset)  "${COMPOSE[@]}" down -v ;;
  status) "${COMPOSE[@]}" ps ;;
  logs)   "${COMPOSE[@]}" logs --tail=100 "$@" ;;
  *)      echo "usage: dev-infra.sh up|down|status|reset|logs [service]" >&2; exit 2 ;;
esac
