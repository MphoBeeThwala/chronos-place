# ADR-0021: GraphQL gateway

Status: Accepted (2026-11-21, product owner approved the M1.3 plan and decisions a–d).

## Decisions
- **One front door.** `services/gateway` (NestJS, Apollo Server on Fastify) serves the client schema from `@chronos/contracts` at `/graphql`. The web app reaches it through its same-origin `/api/graphql` rewrite (ADR-0017). The gateway has no data of its own; it calls services over gRPC.
- **Sessions live in cookies only** (ADR-0017, ADR-0018). After sign-in the gateway sets:
  - `chronos_access`: the access token, `Path=/`.
  - `chronos_refresh`: the refresh token, scoped to the GraphQL path.
  - `chronos_session`: a presence marker with no token in it, for the web app's middleware.
  - `chronos_device`: a random device id, for identity's limits and device binding.

  All four are `HttpOnly`, `SameSite=Strict` and `Secure`. Only local HTTP development may drop `Secure`.
- **Access tokens are verified locally** with identity's public keys (`GetSigningKeys`), cached. An unknown key id triggers at most one refetch every 10 seconds, so forged key ids cannot flood identity.
- **The sign-in guard** runs after validation and before any resolver:
  - Without a valid session, only `requestOtp`, `verifyOtp` and `refreshSession` are allowed (M1.3 AC).
  - Before onboarding is finished, only the onboarding steps are allowed (`ONBOARDING_FIELDS` in `@chronos/contracts`).
  - An account that may no longer sign in is treated as signed out.
  - Fragments cannot hide a field from the guard.
- **Silent refresh (decision c):** members stay signed in for 30 days of activity on a device; the 10-minute access token is renewed through `refreshSession` without the member noticing. The gateway lets only one refresh per refresh token run at a time (ADR-0018), so a burst of parallel requests never looks like token theft:
  - Refreshes arriving at the same replica share one exchange, and every response carries the new cookies.
  - A refresh arriving at another replica while one is in flight (a Redis lock, keyed by a hash of the token) gets `REFRESH_IN_PROGRESS` without reaching identity. The client retries; by then the browser holds the new cookies.
- **Not yet built (decision d):** schema fields whose service does not exist answer `NOT_AVAILABLE`.
- **Errors:**
  - Clients see only known codes, with their fixed messages.
  - Parse and validation errors keep their code but lose their text, because the text can quote literal values from the query, such as a phone number (CLAUDE.md rule 3).
  - Anything else becomes a generic `INTERNAL_SERVER_ERROR`.
- **Request hygiene:**
  - Apollo's CSRF prevention is on. Introspection, playground and stack traces are off outside development.
  - The client IP is taken from `X-Forwarded-For` only up to the configured number of trusted proxies.
- **Limits (decisions a and b).** All of these run before a query is parsed or a resolver runs:
  - Rate limits in Redis: 300 requests a minute per IP and 600 per signed-in account. Every request counts, including refused ones. Over the limit, the answer is HTTP 429 with `RATE_LIMITED` and a `retryAfterSeconds` hint. IP addresses appear in keys only as keyed hashes.
  - Size: at most 20,000 characters of query text and 16 KB of variables (HTTP 413). Batched requests are off.
  - Depth: at most 10 levels, counted through fragments.
  - Complexity: at most 1,000. Paginated fields multiply their children's cost by the page size asked for.
- **Approved operations (decision b).** The manifest maps the SHA-256 of each approved operation to its text, and is built from the web app's code. Outside development, a request must name an approved operation by hash. The gateway runs the manifest's text, ignoring any text the client sends, and refuses everything else with `PERSISTED_QUERY_NOT_FOUND`. Apollo's automatic persisted queries are off, so clients cannot register new operations. Development and test also accept free-form queries.
- A query that selects only `__typename` is allowed without a session: it selects and reveals nothing.
- **Where the manifest comes from.** Every operation the web app sends lives in `apps/web/src/graphql/operations.graphql`. `pnpm --filter @chronos/web operations:gen` writes:
  - `persisted-operations.json`: the manifest the gateway loads as `PERSISTED_OPERATIONS_PATH`.
  - `operations.generated.ts`: the hashes the web app attaches to each request.

  The web app's tests fail when either file is out of date or when an operation does not validate against the schema.
- **Silent refresh in the browser.** When a request fails with `UNAUTHENTICATED`, the web app refreshes once (shared by every request in the tab), then retries. If the session cannot be refreshed, it goes to `/sign-in`.

## Consequences
- Access-token issuing and verifying moved to `@chronos/session-tokens`, shared by identity and the gateway, because services must not import each other.
- The gateway calls identity over plain gRPC for now. mTLS and the per-method caller allow-list arrive with M2.5, and production cannot run before then.
