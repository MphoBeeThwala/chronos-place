# @chronos/gateway

The GraphQL front door for the member app (TASKS M1.3, [ADR-0021](../../docs/adr/0021-graphql-gateway.md)). It serves `packages/contracts/graphql/schema.graphql` at `/graphql`. The web app reaches it through its same-origin `/api/graphql` rewrite. It stores nothing; it calls services over gRPC.

- Sessions live in `HttpOnly`, `SameSite=Strict` cookies only. Tokens never reach browser JavaScript.
- Without a session, only `requestOtp`, `verifyOtp` and `refreshSession` work. Before onboarding is finished, only the onboarding steps work.
- Selfie verification ([ADR-0022](../../docs/adr/0022-liveness-verification.md)): captures are posted as JSON to `POST /verification/capture` (signed-in, onboarded members; at most 3 MB of images; `Cache-Control: no-store`). Fields in `VERIFIED_FIELDS` answer `VERIFICATION_REQUIRED` until the member is verified.
- Errors carry known codes and fixed messages only.
- Limits: 300 requests a minute per IP and 600 per account, a query depth of 10 and complexity of 1,000, and size caps. Outside development, only approved operations run.

## Configuration

Shared settings come from `@chronos/service-kit`. The gateway's own settings (`src/config.ts`):

| Variable                    | Default           | Notes                                                                                                                                                                                                                                                 |
| --------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDENTITY_GRPC_ADDRESS`     | `127.0.0.1:50052` | Identity's gRPC API.                                                                                                                                                                                                                                  |
| `PROFILE_GRPC_ADDRESS`      | `127.0.0.1:50053` | Profile's gRPC API: `me`, `updateProfile`, `updatePreferences`, `profileCatalogue`, and the photo mutations (`createPhotoUpload`, `completePhotoUpload`, `reorderPhotos`, `deletePhoto`).                                                             |
| `DISCLOSURE_GRPC_ADDRESS`   | `127.0.0.1:50055` | The Disclosure Service, the only door to health data: every health field and `shareHealthCard`.                                                                                                                                                       |
| `MATCHING_GRPC_ADDRESS`     | `127.0.0.1:50056` | Matching (M3.1): `like`, `pass`, `unmatch`, `block`, `unblock`, `matches`, `blockedMembers`, and the match behind `shareHealthCard`. Liking someone the member cannot see answers as no match, without asking matching, so a block is never revealed. |
| `DISCOVERY_GRPC_ADDRESS`    | `127.0.0.1:50057` | Discovery (M3.2): `feed`. Discovery gives ids in order; the cards come from profile, which applies blocks, private mode and distance rounding again. `feed.status` says why a feed is empty (`LOCATION_REQUIRED`, `PROFILE_REQUIRED`).                |
| `REDIS_URL`                 | (required)        | Refresh locks across replicas; rate limits next.                                                                                                                                                                                                      |
| `RATE_LIMIT_HASH_KEY`       | (required)        | Base64, at least 32 bytes. Keyed hashes of IPs in rate-limit keys.                                                                                                                                                                                    |
| `PERSISTED_OPERATIONS_PATH` | (unset)           | The approved-operations manifest. Required outside development.                                                                                                                                                                                       |
| `GRAPHQL_PUBLIC_PATH`       | `/api/graphql`    | The path the browser uses; the refresh cookie is scoped to it.                                                                                                                                                                                        |
| `COOKIE_SECURE`             | `true`            | Only local HTTP development may set `false`.                                                                                                                                                                                                          |
| `TRUSTED_PROXY_HOPS`        | `1`               | Proxies whose `X-Forwarded-For` entries are trusted.                                                                                                                                                                                                  |

## Tests

```sh
pnpm --filter @chronos/gateway test               # unit and HTTP end-to-end (against fake identity and profile gRPC servers)
pnpm --filter @chronos/gateway test:privacy       # leak harness over logs and responses
pnpm --filter @chronos/gateway test:integration   # Redis lock (Testcontainers, or TEST_REDIS_URL)
```

Outside development, mount `apps/web/src/graphql/persisted-operations.json` and point `PERSISTED_OPERATIONS_PATH` at it. Rebuild it with `pnpm --filter @chronos/web operations:gen` whenever the web app's operations change.
