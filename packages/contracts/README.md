# @chronos/contracts

Contracts first: change this package before implementing against it.

| Area    | Location                             | Notes                                                    |
| ------- | ------------------------------------ | -------------------------------------------------------- |
| gRPC    | `proto/chronos/<service>/v1/*.proto` | Buf-linted; generated TypeScript in `gen/` (git-ignored) |
| Events  | `src/events`                         | Zod schemas (added in M0.7 part 2)                       |
| GraphQL | `graphql/schema.graphql`             | Client API (added in M0.7 part 3)                        |

```sh
pnpm --filter @chronos/contracts contracts:gen        # buf generate
pnpm --filter @chronos/contracts contracts:breaking   # compare with origin/main
```

`@chronos/contracts/disclosure` is the generated Disclosure Service client and server interfaces. Only the gateway, discovery, identity and moderation services (and `restricted/`) may import it; lint enforces this (ADR-0012). See ADR-0015 for the API design.

## Events

```ts
import { createEvent, parseEvent, partitionKey } from '@chronos/contracts/events';

const event = createEvent('match.created', 'matching', { matchId, accountIds: [a, b] }); // producer side
const received = parseEvent('match.created', JSON.parse(message.value)); // consumer side: validate at the edge
const key = partitionKey(received); // keeps related events in order
```

- Every event has the envelope `eventId`, `type`, `version`, `occurredAt`, `producer`, `data`. Consumers dedupe on `eventId`.
- Schemas are strict: an unknown field is rejected. Each topic names the services allowed to publish it.
- Payloads hold ids and timestamps only. A test fails if any field name is on the logger's redaction list.
- **Disclosure changes are not events.** Even "this member changed their health visibility" implies health data. Clearing open health screens (ADR-0009) must use a signal that does not say why.
- `ContractError` names the failing fields, never their values.
