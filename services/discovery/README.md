# Discovery service

The feed: who a member is shown, in order (TASKS M3.2, [ADR-0026](../../docs/adr/0026-discovery-candidates.md)).

- **No copy of member data.** A feed is built from profile's `FindCandidates` (visible, in range, intent, and age and gender fitting both ways, nearest first). Matching's `FilterCandidates` then removes blocks, members already liked or passed, past matches, and private members who have not liked the viewer.
- **Kept 15 minutes** in Redis (approved): up to 200 account ids with their private flag, under `discovery:feed:v1:<viewer>`. Nothing else is stored: no profile text, coordinates, distances or health data.
- **Every page is checked with matching again,** so a block or a like since the feed was built applies at once. The gateway then asks profile for the cards, which applies blocks, private mode and rounding once more.
- **Fail closed:** if profile or matching cannot answer, the feed is UNAVAILABLE rather than unfiltered.
- **Not on the erasure list:** the cache expires within 15 minutes and holds ids only (ADR-0026). Profile stops showing an erased member at once.
- **Ranking v1** ([ADR-0027](../../docs/adr/0027-ranking-v1.md)): closeness 30, activity 25, mutual fit 20, completeness 15, new member 10, from signals profile and identity work out (0 to 100 each; no health data, no distance, no date). Ties keep nearest-first order. Only the order is kept.
- **Condition-aware filtering** (M3.4, spec 4.3, approved):
  - **How it works:** after matching's filter, the pool goes to the Disclosure Service's `FilterEligibleSubjects`, ids only and at most 500 a call. Discovery never learns which conditions.
  - **When it applies:** with 20 or more matches, the feed shows only them (`ON`). Otherwise it shows the usual feed and says why: `TOO_FEW_NEARBY`, `NEEDS_YOUR_SHARING` or `UNAVAILABLE`. With no wanted conditions it is `OFF`.
  - **Where it's kept:** a feed a condition filter touched, and its state, stays **in this process's memory only** (`MemoryFeedCache`, up to 20,000 feeds, 15 minutes, or 1 minute when the vault was unavailable). It is never written to Redis, and the Redis cache refuses one.
  - **What's logged:** neither the state nor the feed's size, since either could hint at health.
  - **Known limit:** a member who stops sharing, or turns filters off, can stay in someone's filtered feed until it expires (up to 15 minutes). Their health details are never shown that way. Pages from another discovery instance start the feed from the top.

## Configuration

| Variable                  | Default           | Notes                            |
| ------------------------- | ----------------- | -------------------------------- |
| `REDIS_URL`               | (required)        | Feed lists.                      |
| `PROFILE_GRPC_ADDRESS`    | `127.0.0.1:50053` | `FindCandidates`.                |
| `MATCHING_GRPC_ADDRESS`   | `127.0.0.1:50056` | `FilterCandidates`.              |
| `DISCLOSURE_GRPC_ADDRESS` | `127.0.0.1:50055` | `FilterEligibleSubjects` (M3.4). |

gRPC listens on `GRPC_PORT` (locally 50057); only the gateway may call `GetFeed`.

## Tests

```
pnpm --filter @chronos/discovery test               # unit and gRPC, with fakes
pnpm --filter @chronos/discovery test:integration   # the Redis cache (TEST_REDIS_URL)
```

Cross-service: `tools/acceptance/test/discovery.integration.test.ts` runs the real profile, matching and discovery together.
