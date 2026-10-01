# Architecture Decision Records

Status values: Proposed, Accepted, Superseded. Decisions below were taken by the lead engineer on 2026-10-01 under delegation from the product owner. Items marked **needs external input** cannot be closed by engineering alone.

| ADR | Decision | Status |
| --- | --- | --- |
| 0001 | Stack baseline and what we deliberately do not build at GA | Accepted |
| 0002 | Restricted-zone boundary and the contracts exception | Accepted |
| 0003 | End-to-end encrypted messaging (libsignal) | Accepted |
| 0004 | Service mesh: Istio ambient | Accepted |
| 0005 | Observability, analytics and error tracking, all self-hosted | Accepted |
| 0006 | OTP and SMS provider behind an interface | Accepted (commercial terms need validation) |
| 0007 | Ranking and search: rules-based, Postgres/PostGIS and Redis, no OpenSearch at GA | Accepted |
| 0008 | Feature flags: OpenFeature with self-hosted Unleash | Accepted |
| 0009 | Health views are never cached; revocation is pushed | Accepted |
| 0010 | Spec and PRD conflicts resolved | Accepted |
| 0011 | Cloud provider stays AWS; Cloudflare only as optional edge | Accepted (proxy question needs counsel) |
| 0012 | Restricted-zone boundary enforced by a custom ESLint rule | Accepted |
| 0013 | SeaweedFS replaces MinIO for local object storage | Accepted |
