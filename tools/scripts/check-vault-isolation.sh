#!/usr/bin/env bash
# Proves the Health Vault database is unreachable from containers outside vault-net (M0.3 AC).
# Requires the stack to be running (`pnpm dev:infra`). Exits non-zero on any failed check.
set -uo pipefail

PROJECT="chronos"
VAULT_NET="${PROJECT}_vault-net"
CORE_NET="${PROJECT}_core-net"
CLIENT_IMAGE="postgres:17-alpine" # already used by the stack; ships pg_isready
failures=0

pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1" >&2; failures=$((failures + 1)); }

# pg_isready exits 0 when the server accepts connections.
reachable() { # network host port
  docker run --rm --network "$1" "$CLIENT_IMAGE" pg_isready -q -t 4 -h "$2" -p "$3" >/dev/null 2>&1
}

echo "Vault isolation checks"

vault_id="$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=postgres-vault")"
if [[ -z "$vault_id" ]]; then
  echo "postgres-vault is not running. Start the stack with: pnpm dev:infra" >&2
  exit 2
fi
vault_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"${VAULT_NET}\").IPAddress}}" "$vault_id")"
# Every address the vault has on any network, including ones it should not be on.
all_ips="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$vault_id")"
vault_name="$(docker inspect -f '{{.Name}}' "$vault_id" | tr -d '/')"

# Positive control: the check itself works, so a "blocked" result means something.
if reachable "$VAULT_NET" postgres-vault 5432; then pass "container on vault-net reaches the vault (control)"; else fail "control: vault-net container cannot reach the vault"; fi

# Only the vault may sit on vault-net.
members="$(docker network inspect "$VAULT_NET" -f '{{range .Containers}}{{.Name}} {{end}}')"
if [[ "$members" == "chronos-postgres-vault-1 " ]]; then pass "vault-net contains only postgres-vault"; else fail "vault-net members: ${members:-none}"; fi

# Containers on core-net must not resolve or reach the vault.
if reachable "$CORE_NET" postgres-vault 5432; then fail "core-net container reached the vault by name"; else pass "core-net container cannot reach the vault by name"; fi
if reachable "$CORE_NET" "$vault_name" 5432; then fail "core-net container reached the vault by container name"; else pass "core-net container cannot reach the vault by container name"; fi
for ip in $all_ips; do
  if reachable "$CORE_NET" "$ip" 5432; then fail "core-net container reached the vault at $ip"; else pass "core-net container cannot reach the vault at $ip"; fi
done

# The default bridge (any other container on the host) must not reach it either.
for ip in $all_ips; do
  if reachable bridge "$ip" 5432; then fail "default-bridge container reached the vault at $ip"; else pass "default-bridge container cannot reach the vault at $ip"; fi
done

# The host port is bound to 127.0.0.1, so containers cannot reach it through the host gateway.
gateway="$(docker network inspect "$CORE_NET" -f '{{(index .IPAM.Config 0).Gateway}}')"
if reachable "$CORE_NET" "$gateway" 5433; then fail "core-net container reached the vault through the host gateway"; else pass "vault host port is not reachable from containers via the gateway"; fi

if (( failures > 0 )); then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "All vault isolation checks passed"
