# Discovery service

The feed: who a member is shown, in order (TASKS M3.2, [ADR-0026](../../docs/adr/0026-discovery-candidates.md)).

- **No copy of member data.** A feed is built from profile's `FindCandidates` (visible, in range, intent, and age and gender fitting both ways, nearest first). Matching's `FilterCandidates` then removes blocks, members already liked or passed, past matches, and private members who have not liked the viewer.
- **Kept 15 minutes** in Redis (approved): up to 200 account ids with their private flag, under `discovery:feed:v1:<viewer>`. Nothing else is stored: no profile text, coordinates, distances or health data.
- **Every page is checked with matching again,** so a block or a like since the feed was built applies at once. The gateway then asks profile for the cards, which applies blocks, private mode and rounding once more.
- **Fail closed:** if profile or matching cannot answer, the feed is UNAVAILABLE rather than unfiltered.
- **Not on the erasure list:** the cache expires within 15 minutes and holds ids only (ADR-0026). Profile stops showing an erased member at once.
- **Ranking v1** ([ADR-0027](../../docs/adr/0027-ranking-v1.md)): closeness 30, activity 25, mutual fit 20, completeness 15, new member 10, from signals profile and identity work out (0 to 100 each; no health data, no distance, no date). Ties keep nearest-first order. Only the order is kept.
- Condition-aware filtering (M3.4) comes next.

## Configuration

| Variable                | Default           | Notes               |
| ----------------------- | ----------------- | ------------------- |
| `REDIS_URL`             | (required)        | Feed lists.         |
| `PROFILE_GRPC_ADDRESS`  | `127.0.0.1:50053` | `FindCandidates`.   |
| `MATCHING_GRPC_ADDRESS` | `127.0.0.1:50056` | `FilterCandidates`. |

gRPC listens on `GRPC_PORT` (locally 50057); only the gateway may call `GetFeed`.

## Tests

```
pnpm --filter @chronos/discovery test               # unit and gRPC, with fakes
pnpm --filter @chronos/discovery test:integration   # the Redis cache (TEST_REDIS_URL)
```

Cross-service: `tools/acceptance/test/discovery.integration.test.ts` runs the real profile, matching and discovery together.
