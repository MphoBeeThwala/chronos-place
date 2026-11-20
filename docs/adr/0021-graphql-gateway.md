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
- **Limits (decisions a and b, next PRs):**
  - Rate limits in Redis: 300 requests a minute per IP and 600 per signed-in account.
  - Query depth (10) and complexity limits, plus a request size cap.
  - In production, only queries from a manifest built from the web app's code are accepted. Development and test accept any query.

## Consequences
- Access-token issuing and verifying moved to `@chronos/session-tokens`, shared by identity and the gateway, because services must not import each other.
- The gateway calls identity over plain gRPC for now. mTLS and the per-method caller allow-list arrive with M2.5, and production cannot run before then.
