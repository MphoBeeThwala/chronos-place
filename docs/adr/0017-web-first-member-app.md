# ADR-0017: Web-first member app

Status: Accepted (2026-11-19, product owner). Items marked **needs external input** stay open.

## Context
ADR-0001, `CLAUDE.md` and the spec planned the member app as Expo React Native (`apps/mobile`), with Next.js only for staff and partner consoles. M0.12 was delivered as a Next.js member web app (`apps/web`, merged in PR #17) without a decision record. The product owner has chosen to keep that direction.

## Decision
- **The member app ships first as a responsive, mobile-first Next.js web app in `apps/web`.** It talks only to the GraphQL gateway, like every client.
- **The native app (Expo, `apps/mobile`) is deferred, not dropped.** It reuses the same GraphQL schema and `packages/contracts`. It will be planned as its own milestone (M8) after private beta. Spec section 9 stays the target for native.
- **The admin console stays a separate app (`apps/admin`, M5)** with staff SSO. Staff and member code never share an app, session or origin.
- **`packages/ui` holds design tokens** (TypeScript values plus CSS custom properties), so a later native app can reuse the same values. Web components live in `apps/web` for now.
- **E2E tests use Playwright** for member journeys. Every task acceptance criterion that named Maestro now names Playwright. Maestro returns with the native app.

## Web replacements for spec section 9 (mobile specifics)
These rules apply to every screen and API call in `apps/web`.

| Mobile control | Web equivalent |
| --- | --- |
| SecureStore for tokens | Session in an `httpOnly`, `Secure`, `SameSite=Strict` cookie set by the gateway. No token, health data or personal data in `localStorage`, `sessionStorage`, IndexedDB or the Cache API. Only harmless UI preferences (theme, language) may be stored on the device. |
| Health views in memory only (ADR-0009) | Health routes render per request and are served with `Cache-Control: no-store`, which also keeps them out of the back/forward cache. No service worker may cache any authenticated route. Apollo client caches are in-memory only and are never persisted. |
| `FLAG_SECURE` / iOS snapshot blur | **Browsers cannot block screenshots.** Health screens blur when the tab is hidden, print a placeholder instead of content and show a notice. The UI must tell members plainly that the web cannot prevent screenshots. |
| App lock, quick exit, neutral icons | A quick-exit control (button plus keyboard shortcut) that replaces the current history entry and leaves to a neutral site. Neutral page titles and favicon on every route. An idle timeout ends the session. |
| Content-free push | Web Push with the same rule: generic text only (M6). |
| Gateway access | The browser calls only the same-origin `/api/graphql` path, rewritten to the gateway. No gateway URL in the browser bundle, so cookies stay first-party and the CSP keeps `connect-src 'self'`. |
| URLs | No health data or anything implying it in paths or query strings (CLAUDE.md rule 3). Redirects do not carry a return path in the query string. |

**Content Security Policy.** The shell currently allows `'unsafe-inline'` scripts for the theme bootstrap and Next.js hydration. Before any screen shows health data (M2.8), the CSP must move to per-request nonces with `'strict-dynamic'`, and `img-src` must narrow to the app and the media CDN. This is tracked as task M1.9.

**Camera.** `Permissions-Policy` blocks the camera everywhere except `/verify`, the selfie check (M1.4, ADR-0022). Photo upload (M1.6) will open it for its own route only.

## Consequences and open questions
- **End-to-end encrypted chat on the web (needs external input).** ADR-0003 relies on libsignal's Swift and Kotlin bindings and device keystores. libsignal has no supported browser build. The M4.1 spike must now cover the web: compiling libsignal to WebAssembly ourselves (with an audit), or holding chat until the native app ships. Browser key storage (non-extractable WebCrypto keys in IndexedDB) is weaker than a hardware keystore, and the spike must state that risk.
- **Liveness vendor (M1.4).** The vendor's web SDK must pass rule 7 (no phoning home beyond the verification itself) before it is chosen.
- **Store-only features** (OS-level app lock, alternate icons) are unavailable until the native app ships. The PRD privacy promises must be checked against the web controls above (**needs product and counsel review**).
- Accessibility targets are unchanged: WCAG 2.2 AA, 44x44 px targets, button alternatives to swipes.
