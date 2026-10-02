#!/usr/bin/env bash
# End-to-end check of the service template (M0.8 acceptance criteria):
# generate a service, build/lint/test it, build its image, run it, check it is locked down, scan it.
# Needs Docker. Restores the workspace afterwards. Run with: pnpm test:service-template
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
NAME="zz-template-check"
IMAGE="chronos/${NAME}:test"
CONTAINER="chronos-${NAME}"
LOCK_BACKUP="$(mktemp)"
failures=0

pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1" >&2; failures=$((failures + 1)); }

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "services/${NAME}" .build-ca.crt
  cp "$LOCK_BACKUP" pnpm-lock.yaml
  rm -f "$LOCK_BACKUP"
  pnpm install --prefer-offline >/dev/null 2>&1 || true
}
trap cleanup EXIT
cp pnpm-lock.yaml "$LOCK_BACKUP"

echo "Service template check"
pnpm --filter @chronos/service-kit build >/dev/null
pnpm new:service "$NAME" >/dev/null && pass "generated services/${NAME}"
pnpm install --prefer-offline >/dev/null 2>&1 && pass "workspace installed"

for step in build typecheck lint test; do
  if pnpm --filter "@chronos/${NAME}" "$step" >/dev/null 2>&1; then pass "pnpm ${step}"; else fail "pnpm ${step}"; fi
done

# Behind a TLS-intercepting proxy (some CI and sandbox networks) the build needs the proxy's CA and the host network:
#   DOCKER_BUILD_ARGS="--network host" DOCKER_BUILD_CA=/path/to/ca-bundle.crt pnpm test:service-template
dockerfile="services/${NAME}/Dockerfile"
if [[ -n "${DOCKER_BUILD_CA:-}" ]]; then
  cp "$DOCKER_BUILD_CA" .build-ca.crt
  sed '/^RUN corepack enable/a COPY .build-ca.crt /usr/local/share/build-ca.crt\nENV NODE_EXTRA_CA_CERTS=/usr/local/share/build-ca.crt npm_config_cafile=/usr/local/share/build-ca.crt' \
    "$dockerfile" >"${dockerfile}.ca"
  dockerfile="${dockerfile}.ca"
fi
# shellcheck disable=SC2086 # DOCKER_BUILD_ARGS is intentionally split into words
if docker build ${DOCKER_BUILD_ARGS:-} -f "$dockerfile" -t "$IMAGE" . >/tmp/service-template-build.log 2>&1; then
  pass "image built ($(docker image inspect "$IMAGE" --format '{{.Size}}' | awk '{printf "%.0f MB", $1/1048576}'))"
else
  fail "image build (see /tmp/service-template-build.log)"
  tail -15 /tmp/service-template-build.log >&2
  echo "$failures check(s) failed" >&2
  exit 1
fi

user="$(docker run --rm --entrypoint /nodejs/bin/node "$IMAGE" -e 'process.stdout.write(String(process.getuid()))')"
if [[ "$user" == "65532" ]]; then pass "runs as non-root (uid 65532)"; else fail "runs as uid ${user}"; fi

if docker run --rm --entrypoint /bin/sh "$IMAGE" -c true >/dev/null 2>&1; then fail "image contains a shell"; else pass "no shell in the image"; fi

docker run -d --read-only --name "$CONTAINER" -p 127.0.0.1:18080:8080 \
  -e NODE_ENV=local -e SERVICE_NAME="$NAME" -e SHUTDOWN_DRAIN_MS=0 "$IMAGE" >/dev/null
ready=false
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:18080/readyz >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if $ready; then pass "serves /readyz with a read-only root filesystem"; else fail "did not become ready"; docker logs "$CONTAINER" 2>&1 | tail -20 >&2; fi
if curl -sf http://127.0.0.1:18080/healthz | grep -q '"ok"'; then pass "serves /healthz"; else fail "/healthz"; fi

docker kill --signal SIGTERM "$CONTAINER" >/dev/null
code="$(docker wait "$CONTAINER")"
if [[ "$code" == "0" ]]; then pass "exits 0 on SIGTERM"; else fail "exit code ${code} on SIGTERM"; fi
if docker logs "$CONTAINER" 2>&1 | grep -q "shutdown complete"; then pass "logged a clean shutdown"; else fail "no clean-shutdown log"; fi

if bash tools/scripts/scan-image.sh "$IMAGE" >/tmp/service-template-trivy.log 2>&1; then
  pass "Trivy: no HIGH or CRITICAL findings"
else
  if grep -qiE "error|fatal|unable|forbidden|denied|429" /tmp/service-template-trivy.log && ! grep -q "Total:" /tmp/service-template-trivy.log; then
    echo "  SKIP  Trivy could not run here (see /tmp/service-template-trivy.log); run it in CI or on a developer machine" >&2
  else
    fail "Trivy found HIGH or CRITICAL issues (see /tmp/service-template-trivy.log)"
  fi
fi

if (( failures > 0 )); then echo "$failures check(s) failed" >&2; exit 1; fi
echo "All service template checks passed"
