#!/usr/bin/env bash
# Applies every service's database migrations to the local stack (forward-only).
# Uses DATABASE_URL if set; otherwise builds it from tools/.env (see `pnpm dev:infra`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/tools/.env"

if [[ -z "${DATABASE_URL:-}" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "No DATABASE_URL and no tools/.env. Run pnpm dev:infra first." >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  export DATABASE_URL="postgres://chronos:${POSTGRES_CORE_PASSWORD}@127.0.0.1:5432/chronos_core"
fi

cd "$ROOT"
pnpm turbo run build --filter='@chronos/identity...' --filter='@chronos/profile...' --output-logs=errors-only
pnpm --filter '@chronos/identity' db:migrate
pnpm --filter '@chronos/profile' db:migrate
