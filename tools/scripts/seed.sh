#!/usr/bin/env bash
# Synthetic members into the local core database (CLAUDE.md rule 6). Run `pnpm db:migrate` first.
# Uses DATABASE_URL if set; otherwise builds it from tools/.env (see `pnpm dev:infra`).
# Options: --members N (default 200000), --reset (replace earlier seeded members).
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
pnpm turbo run build --filter='@chronos/seed...' --output-logs=errors-only
node tools/seed/dist/cli.js "$@"
