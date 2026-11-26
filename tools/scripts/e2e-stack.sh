#!/usr/bin/env bash
# Onboarding end to end against the real services (TASKS M1.7): builds and migrates, starts
# identity, profile and the gateway on this machine, runs apps/web's e2e/stack tests, then stops
# the services. Needs the local stack (`pnpm dev:infra`), or the same pieces on the same ports:
# PostgreSQL+PostGIS 5432, Redis 6379, SeaweedFS S3 8333, KMS (LocalStack) 4566, Mailpit 8025.
#
# Settings come from tools/.env (written by dev:infra) unless set in the environment:
#   DATABASE_URL, REDIS_URL, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, KMS_ENDPOINT,
#   IDENTITY_DATA_KEY_ID (otherwise a key is created in the local KMS).
# Every secret below is made up per run and never written to disk. Synthetic data only.
# Extra arguments go to Playwright, e.g. `pnpm test:e2e:stack --project=chromium`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/tools/.env"
cd "$ROOT"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  : "${DATABASE_URL:=postgres://chronos:${POSTGRES_CORE_PASSWORD}@127.0.0.1:5432/chronos_core}"
  : "${REDIS_URL:=redis://:${REDIS_PASSWORD}@127.0.0.1:6379}"
  : "${S3_ACCESS_KEY_ID:=${S3_ACCESS_KEY}}"
  : "${S3_SECRET_ACCESS_KEY:=${S3_SECRET_KEY}}"
fi
for name in DATABASE_URL REDIS_URL S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name is not set and there is no tools/.env. Run pnpm dev:infra first." >&2
    exit 1
  fi
done
: "${KMS_ENDPOINT:=http://127.0.0.1:4566}"
MAILPIT_URL=http://127.0.0.1:8025
export DATABASE_URL
# Local KMS (LocalStack) accepts any credentials; these are not secrets.
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test

random() { head -c 32 /dev/urandom | base64; }

echo "Building and migrating…"
pnpm turbo run build --filter=@chronos/identity --filter=@chronos/profile --filter=@chronos/matching \
  --filter=@chronos/gateway --filter='@chronos/web^...' --output-logs=errors-only
pnpm db:migrate >/dev/null
# Service-to-service mTLS (M2.5): each service presents its own dev certificate.
node tools/scripts/dev-certs.mjs >/dev/null
CERTS="$ROOT/tools/.certs"

if [[ -z "${IDENTITY_DATA_KEY_ID:-}" ]]; then
  IDENTITY_DATA_KEY_ID="$(cd services/identity && KMS_ENDPOINT="$KMS_ENDPOINT" node --input-type=module -e "
    import { KMSClient, CreateKeyCommand } from '@aws-sdk/client-kms';
    const kms = new KMSClient({ region: 'af-south-1', endpoint: process.env.KMS_ENDPOINT });
    const { KeyMetadata } = await kms.send(new CreateKeyCommand({ Description: 'synthetic e2e' }));
    console.log(KeyMetadata.KeyId);")"
fi

LOGS="$(mktemp -d)"
PIDS=()
stop() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap stop EXIT

# NODE_ENV=local: the development stand-ins (Mailpit for SMS, the fake liveness check,
# auto-approved photos) are allowed. gRPC still runs over mTLS with the dev certificates.
start() {
  local service=$1 port=$2
  shift 2
  (cd "services/$service" && exec env NODE_ENV=local SERVICE_NAME="$service" HTTP_PORT="$port" \
    GRPC_TLS_CERT_PATH="$CERTS/$service.pem" GRPC_TLS_KEY_PATH="$CERTS/$service.key" \
    GRPC_TLS_CA_PATH="$CERTS/ca.pem" "$@" \
    node --import @chronos/service-kit/instrument dist/main.js) >"$LOGS/$service.log" 2>&1 &
  PIDS+=($!)
}
start identity 8101 GRPC_PORT=50052 DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" \
  KMS_ENDPOINT="$KMS_ENDPOINT" IDENTITY_DATA_KEY_ID="$IDENTITY_DATA_KEY_ID" \
  PHONE_LOOKUP_KEY="$(random)" OTP_CODE_KEY="$(random)" MAILPIT_URL="$MAILPIT_URL"
start profile 8102 GRPC_PORT=50053 DATABASE_URL="$DATABASE_URL" \
  IDENTITY_GRPC_ADDRESS=127.0.0.1:50052 PHOTO_UPLOAD_BUCKET=photo-uploads \
  PHOTO_MEDIA_BUCKET=photo-media S3_ENDPOINT=http://127.0.0.1:8333 \
  S3_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" S3_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
# Profile asks matching for blocks and shows nobody without it (M3.1).
start matching 8106 GRPC_PORT=50056 DATABASE_URL="$DATABASE_URL"
start gateway 4000 GRPC_PORT=50054 REDIS_URL="$REDIS_URL" RATE_LIMIT_HASH_KEY="$(random)" \
  COOKIE_SECURE=false PERSISTED_OPERATIONS_PATH="$ROOT/apps/web/src/graphql/persisted-operations.json"

for port in 8101 8102 8106 4000; do
  for _ in $(seq 60); do
    curl -sf "http://127.0.0.1:$port/readyz" >/dev/null && continue 2
    sleep 1
  done
  echo "A service on port $port did not become ready. Logs:" >&2
  tail -n 20 "$LOGS"/*.log >&2
  exit 1
done

echo "Services ready. Running the stack tests…"
E2E_STACK=1 NODE_ENV=development SERVICE_NAME=web GATEWAY_URL=http://localhost:4000/graphql \
  pnpm --filter @chronos/web exec playwright test e2e/stack "$@"
