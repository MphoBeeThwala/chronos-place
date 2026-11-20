# @chronos/gateway

The GraphQL front door for the member app (TASKS M1.3, [ADR-0021](../../docs/adr/0021-graphql-gateway.md)). It serves `packages/contracts/graphql/schema.graphql` at `/graphql`. The web app reaches it through its same-origin `/api/graphql` rewrite. It stores nothing; it calls services over gRPC.

- Sessions live in `HttpOnly`, `SameSite=Strict` cookies only. Tokens never reach browser JavaScript.
- Without a session, only `requestOtp`, `verifyOtp` and `refreshSession` work. Before onboarding is finished, only the onboarding steps work.
- Errors carry known codes and fixed messages only.

## Configuration

Shared settings come from `@chronos/service-kit`. The gateway's own settings (`src/config.ts`):

| Variable                | Default           | Notes                                                          |
| ----------------------- | ----------------- | -------------------------------------------------------------- |
| `IDENTITY_GRPC_ADDRESS` | `127.0.0.1:50052` | Identity's gRPC API.                                           |
| `REDIS_URL`             | (required)        | Refresh locks across replicas; rate limits next.               |
| `GRAPHQL_PUBLIC_PATH`   | `/api/graphql`    | The path the browser uses; the refresh cookie is scoped to it. |
| `COOKIE_SECURE`         | `true`            | Only local HTTP development may set `false`.                   |
| `TRUSTED_PROXY_HOPS`    | `1`               | Proxies whose `X-Forwarded-For` entries are trusted.           |

## Tests

```sh
pnpm --filter @chronos/gateway test               # unit and HTTP end-to-end (against a fake identity gRPC server)
pnpm --filter @chronos/gateway test:privacy       # leak harness over logs and responses
pnpm --filter @chronos/gateway test:integration   # Redis lock (Testcontainers, or TEST_REDIS_URL)
```
