# ADR-0009: Health views are never cached; revocation is pushed

## Context
The PRD requires revocation to take effect immediately "including cached copies on devices". The spec said clients must re-request.

## Decision
- The gateway sets `Cache-Control: no-store` on every health response, and health data is excluded from GraphQL response caching, persisted-query result caches, Redis and the CDN.
- The mobile app holds a health view in memory only, scoped to the open screen. It is never written to disk, TanStack Query persistence, logs or the OS snapshot (screen protection, spec section 9).
- Each health view carries a short server-issued lease (60 seconds). When the screen is open past the lease, the app re-requests; a denied response clears the view.
- Revoke, visibility change, block, unmatch and account suspension publish a content-free `disclosure.changed` signal (account IDs only) over the WebSocket. Open health screens clear immediately on receipt, with the lease as the backstop when offline.

## Residual risk
A viewer can photograph a screen. This cannot be prevented technically; it is covered by terms, reporting and the audit trail, and is stated honestly in the privacy walkthrough.
