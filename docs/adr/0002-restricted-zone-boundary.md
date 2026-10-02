# ADR-0002: Restricted-zone boundary and the contracts exception

## Decision
1. Only code under `restricted/` reads or writes health data, and nothing outside `restricted/` imports from it (ESLint boundaries, M0.2).
2. **Exception:** `packages/contracts` may contain the `.proto` files for the Disclosure Service and the types generated from them. Hand-written types describing conditions, statuses or grants outside `restricted/` remain forbidden.
3. Generated types are the wire shape only. Core services never persist them, log them or put them into events, GraphQL schemas for non-health resolvers, or cache keys.
4. The condition taxonomy (codes such as `hiv`, `t1d`) is reference data owned by the vault. The core never ships its own copy of the list; clients receive the list through a Disclosure Service call that returns only the taxonomy, never a member's choices.

## Why
Callers need a typed client. Forcing them to hand-roll one would create the drift and the duplicated health types the rule exists to prevent. Generated code from a single reviewed `.proto` keeps one source of truth.

## Enforcement
- Lint: only the gateway, discovery, identity and moderation packages may import the generated disclosure client, and only the client entry point.
- Privacy tests (M0.10) scan logs, events and error bodies for health markers regardless of where types come from.
- Buf breaking-change checks gate changes to `disclosure/v1`.
