# ADR-0004: Service mesh: Istio ambient

## Decision
Use Istio in ambient mode for mTLS, workload identity and L4/L7 authorization policy.

## Why over Linkerd
- Linkerd stable release artifacts are now commercially licensed by Buoyant, which adds a licensing dependency for a mesh that is part of our security boundary.
- Ambient mode removes per-pod sidecars, which lowers memory overhead and upgrade friction.
- Istio AuthorizationPolicy expresses the per-method caller allow-list for the Disclosure Service at the mesh layer as defence in depth, alongside the gRPC interceptor (M2.5).

## Consequences
Heavier operationally than Linkerd. Mitigated by managed upgrades through Argo CD and pinning to a supported minor version.

## Application-level identity (M2.5)
- Services also run mTLS themselves (`GRPC_TLS_*`), so a service can see who is calling: with ambient mode alone, the mesh terminates mTLS before the application.
- Each certificate carries exactly one URI SAN, `spiffe://chronos-place.internal/<service>` (`GRPC_TRUST_DOMAIN`). The caller's identity comes only from that verified certificate, never from metadata.
- `bootstrapService({ allowList })` installs a default-deny per-method guard. It is required outside local and test for any service with a gRPC API.
- Clients use `grpcClientCredentials(config, expectedServer)`, which presents their own certificate and checks the server's SPIFFE id.
- Local development uses real mTLS with `pnpm dev:certs`. The mesh AuthorizationPolicy repeats the same allow-list once hosting is decided.
