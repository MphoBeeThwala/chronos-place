# ADR-0019: Kafka client for Node.js services

Status: **Proposed** (2026-11-20, revised the same day). Needs product-owner approval before any service depends on it.

## Context
Services publish events (spec 7). The identity service already writes `account.created` to a transactional outbox (`identity.outbox`) and relays it through an `EventPublisher` interface. No Kafka client is in the repository yet. Choosing one is a major dependency (CLAUDE.md). Until this ADR is accepted, events wait safely in the outbox: nothing is lost, and no other service consumes them yet.

The product owner is avoiding AWS for now. This ADR therefore decides **only the client library**, which speaks the Kafka protocol to any broker. **Where Kafka is hosted is a separate, later decision**, taken with the hosting question in ADR-0011. Development needs no cloud at all: Redpanda already runs in `tools/docker-compose.yml`.

Candidates, as checked on 2026-11-20:

| Client | State | Notes |
| --- | --- | --- |
| `kafkajs` | Last release February 2023 | Popular, pure JavaScript, but unmaintained. Rejected. |
| `@platformatic/kafka` | Active (2.17, November 2026) | Pure JavaScript: no native binary to build or to be blocked by Windows application control on developer machines. Younger, smaller track record. |
| `@confluentinc/kafka-javascript` | Maintained by Confluent (1.11, October 2026) | Wraps librdkafka (native, the reference client). Its strongest extra, AWS MSK IAM login, matters less while AWS is on hold. Native module builds can fail or be blocked on locked-down Windows machines. |

## Proposal
- Use **`@platformatic/kafka`**, behind the existing `EventPublisher` and a matching consumer interface in a small shared package (`@chronos/events`). Services never import the client directly, so it can be swapped for `@confluentinc/kafka-javascript` later without touching service code.
- Producers: idempotent, `acks=all`, keyed by `partitionKey` from `@chronos/contracts`. Consumers dedupe on `eventId` (spec 7).
- Locally: Redpanda, no auth. Hosted: TLS plus SASL (SCRAM or PLAIN API keys), whichever the chosen host uses.

## Hosting options for later (not decided here)
All keep data in South Africa, which the spec requires:
- Self-hosted Redpanda or Kafka on the chosen cloud's Kubernetes.
- Google Cloud Managed Service for Apache Kafka, Johannesburg (`africa-south1`).
- Aiven for Apache Kafka on Azure South Africa North.
- Amazon MSK in Cape Town, if AWS comes back.
- Confluent Cloud and Azure Event Hubs (Kafka-compatible): check South African region availability at the time.

## Consequences
- The client choice is reversible behind the interfaces. The hosting choice is not made here and does not block development.
- Event payloads stay governed by `@chronos/contracts`: ids and timestamps only, never health data (CLAUDE.md rule 3), enforced by contract tests and the privacy harness.
