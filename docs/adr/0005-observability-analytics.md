# ADR-0005: Observability, analytics and error tracking

## Decision
- Traces, logs, metrics: OpenTelemetry into self-hosted Grafana stack (Tempo, Loki, Mimir) in af-south-1.
- Errors: self-hosted Sentry with server-side scrubbing; no session replay on mobile or web.
- Product analytics: self-hosted PostHog with a de-identified event schema defined in `packages/contracts`. Events carry an opaque per-install ID, never account ID or location, and a closed list of event names; free-form properties are rejected by the schema.
- The mobile app uses no third-party SDK that calls out to a vendor (PRD principle, CLAUDE.md rule 7). Crash reporting uses the self-hosted Sentry endpoint only.

## Why
PRD non-negotiables: no ad SDKs, analytics self-hosted, health data scrubbed before logging. Managed vendors would require operator agreements and cross-border transfer review.

## Consequences
We operate more infrastructure. Accepted: it is cheaper than a breach and than a transfer approval.
