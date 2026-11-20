# ADR-0019: Kafka client for Node.js services

Status: **Proposed** (2026-11-20). Needs product-owner approval before any service depends on it.

## Context
Services publish events (spec 7) to Kafka: Redpanda locally, Amazon MSK in af-south-1. The identity service already writes `account.created` to a transactional outbox (`identity.outbox`) and relays it through an `EventPublisher` interface. No Kafka client is in the repository yet, and choosing one is a major dependency (CLAUDE.md). Until this ADR is accepted, events wait safely in the outbox: nothing is lost, and no other service consumes them yet.

Candidates, as checked on 2026-11-20:

| Client | State | Notes |
| --- | --- | --- |
| `kafkajs` | Last release February 2023 | Popular, pure JavaScript, but unmaintained. Rejected. |
| `@confluentinc/kafka-javascript` | Maintained by Confluent (1.11, October 2026) | Wraps librdkafka (native, the reference client). Offers a KafkaJS-compatible API. Supports idempotent producers and SASL/OAUTHBEARER, which MSK IAM authentication uses. |
| `@platformatic/kafka` | Active (2.17, November 2026) | Pure JavaScript, no native build. Younger, with a smaller track record on MSK IAM. |

## Proposal
- Use **`@confluentinc/kafka-javascript`** behind the existing `EventPublisher` and a matching consumer interface in a small shared package (`@chronos/events`). Services never import the client directly.
- Producers: idempotent (`enable.idempotence`), `acks=all`, keyed by `partitionKey` from `@chronos/contracts`. Consumers dedupe on `eventId` (spec 7).
- MSK: IAM authentication via OAUTHBEARER tokens; TLS only. Redpanda locally without auth.
- The native module is built in the service images' build stage. The distroless runtime image stays unchanged; Trivy and OSV scans cover it as today.

## Consequences
- A native dependency adds build time and a platform-specific binary. If that proves troublesome, `@platformatic/kafka` can replace it behind the same interfaces without touching services.
- Event payloads stay governed by `@chronos/contracts`: ids and timestamps only, never health data (CLAUDE.md rule 3), enforced by contract tests and the privacy harness.
