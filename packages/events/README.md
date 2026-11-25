# @chronos/events

Publishing and consuming events over Kafka (ADR-0019, spec 7). Services use these interfaces and never import the Kafka client (`@platformatic/kafka`) themselves, so the client can be swapped without touching service code.

- **`KafkaEventPublisher`:** idempotent producer, `acks=all`, keyed by the event's partition key so one member's events stay in order. Identity's outbox relay uses it.
- **`KafkaEventSubscriber`:** consumes as the service's consumer group, from the last committed offset (the earliest the first time).
  - Every message is validated against `@chronos/contracts` before a handler sees it (CLAUDE.md: validate at the edge). An invalid message is logged without its payload, then skipped.
  - An offset is committed only after its handlers succeed. A failing handler is retried in place with growing waits (up to 30 s), so later events for the same partition never overtake it.
- **`deduped(processed, handler)`:** delivery is at least once, so consumers skip an `eventId` they have already handled. Services back `ProcessedEvents` with a table written in the same transaction as the handler's changes.
- **`InMemoryEventBus`:** the same contract checks and redelivery in one process, for tests.
- **`ensureTopics`:** creates missing topics for local development and tests. Deployed topics come from infrastructure code.

No health data is ever published (CLAUDE.md rule 3): payloads are ids and timestamps, enforced by the contracts.

## Tests

```sh
pnpm --filter @chronos/events test                # unit
pnpm --filter @chronos/events test:integration    # Testcontainers Redpanda (Docker), or TEST_KAFKA_BROKERS=127.0.0.1:19092
```
