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

**Content Security Policy (done in M1.9).**
- **Scripts:** the middleware (`src/middleware.ts`, policy in `src/lib/csp.ts`) builds the policy per request with a fresh 128-bit nonce: `script-src 'self' 'nonce-…' 'strict-dynamic'`, with no `'unsafe-inline'`.
- **What carries the nonce:** Next.js stamps it on its own scripts. The root layout stamps the theme bootstrap and Apollo's server-rendered data scripts. Code those scripts load (such as the selfie camera component) is trusted through `'strict-dynamic'`.
- **Development:** it also allows `'unsafe-eval'`, for hot reload. Production never does.
- **Images:** `img-src` is the app plus the photo storage origin (`data:` and `blob:` for local previews), and no longer any https site.
- **Styles:** `style-src` keeps `'unsafe-inline'`. The design tokens are applied through inline `style` attributes, which nonces cannot cover, and styles cannot run code.
- **Also set:** `object-src 'none'`, `base-uri 'none'` and `form-action 'self'`.
- **Tests:** Playwright proves an inline script without the nonce is blocked under the policy the app serves.

**Quick exit, neutral titles and idle sign-out (done in M1.9, choices approved 2026-11-26).**
- **Quick exit:** a "Quick exit" button on every screen (bottom right, above everything, including the idle warning), or Escape pressed twice within 0.8 s.
  - It replaces the current history entry with `https://www.google.com/`, so Back does not return to the page.
  - It signs this device out with a `keepalive` request, so the exit never waits for the reply.
  - Every other open tab of the app leaves too.
- **Titles:** every page title reads "page name — Chronos Place", and no title, description or address may imply health. A source scan and a Playwright test enforce it.
  - The placeholder `/health` route became `/private`.
  - The site description is now "Dating and connection, on your terms.", as in the app manifest.
- **Idle sign-out:** after 15 minutes with no activity in any open tab of the app, this device is signed out, with a warning and "Stay signed in" one minute before (WCAG 2.2.1).
  - Tabs share activity through `BroadcastChannel`, in memory only.
  - Public pages are skipped.
  - **Limitation:** the timer runs only while a tab is open. A session left with every tab closed lasts until its refresh token expires. A server-side idle limit in identity would close that gap; it is an auth change and needs its own decision.

**Camera.** `Permissions-Policy` blocks the camera everywhere except `/verify`, the selfie check (M1.4, ADR-0022). Photo upload (M1.6) will open it for its own route only.

## Consequences and open questions
- **End-to-end encrypted chat on the web (needs external input).** ADR-0003 relies on libsignal's Swift and Kotlin bindings and device keystores. libsignal has no supported browser build. The M4.1 spike must now cover the web: compiling libsignal to WebAssembly ourselves (with an audit), or holding chat until the native app ships. Browser key storage (non-extractable WebCrypto keys in IndexedDB) is weaker than a hardware keystore, and the spike must state that risk.
- **Liveness vendor (M1.4).** The vendor's web SDK must pass rule 7 (no phoning home beyond the verification itself) before it is chosen.
- **Store-only features** (OS-level app lock, alternate icons) are unavailable until the native app ships. The PRD privacy promises must be checked against the web controls above (**needs product and counsel review**).
- Accessibility targets are unchanged: WCAG 2.2 AA, 44x44 px targets, button alternatives to swipes.
