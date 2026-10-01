# ADR-0004: Service mesh: Istio ambient

## Decision
Use Istio in ambient mode for mTLS, workload identity and L4/L7 authorization policy.

## Why over Linkerd
- Linkerd stable release artifacts are now commercially licensed by Buoyant, which adds a licensing dependency for a mesh that is part of our security boundary.
- Ambient mode removes per-pod sidecars, which lowers memory overhead and upgrade friction.
- Istio AuthorizationPolicy expresses the per-method caller allow-list for the Disclosure Service at the mesh layer as defence in depth, alongside the gRPC interceptor (M2.5).

## Consequences
Heavier operationally than Linkerd. Mitigated by managed upgrades through Argo CD and pinning to a supported minor version.
