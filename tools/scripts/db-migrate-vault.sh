#!/usr/bin/env bash
# Applies the Health Vault migrations to the local vault database (forward-only).
# Uses VAULT_DATABASE_URL if set; otherwise builds it from tools/.env (see `pnpm dev:infra`).
# The local vault listens only on 127.0.0.1:5433, so this runs from the host; no container
# other than postgres-vault joins vault-net (`pnpm test:infra` checks that).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/tools/.env"

if [[ -z "${VAULT_DATABASE_URL:-}" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "No VAULT_DATABASE_URL and no tools/.env. Run pnpm dev:infra first." >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  export VAULT_DATABASE_URL="postgres://vault:${POSTGRES_VAULT_PASSWORD}@127.0.0.1:5433/chronos_vault"
fi

cd "$ROOT"
pnpm turbo run build --filter='@chronos/vault-db...' --output-logs=errors-only
pnpm --filter '@chronos/vault-db' db:migrate
