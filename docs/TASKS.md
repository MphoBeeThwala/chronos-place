# Chronos Place — Engineering Backlog

Work top to bottom. One task per branch and pull request. Each task lists acceptance criteria (AC). Milestones M0 to M3 are detailed; later milestones are outlined and will be broken down as earlier ones finish.

Tasks marked **[approval]** touch auth, crypto, the restricted zone, schemas or infrastructure: share a plan and wait for approval before coding.

---

## M0 — Foundations

### M0.1 Monorepo scaffold
- pnpm workspaces + Turborepo; folders per `CLAUDE.md` layout with placeholder packages.
- Shared `tsconfig` (strict) and `eslint-config` packages; Prettier.
- Root scripts: `dev`, `lint`, `typecheck`, `test`, `build`.
- AC: `pnpm install && pnpm lint && pnpm typecheck && pnpm test` pass on a clean clone; README explains setup.

### M0.2 Restricted-zone boundary rule **[approval]**
- ESLint rule (eslint-plugin-boundaries or custom) so nothing outside `restricted/` can import from it, and `restricted/` can import only approved packages.
- AC: a deliberate violating import fails lint in CI; a test fixture proves it.

### M0.3 Local development stack
- `tools/docker-compose.yml`: postgres-core (PostGIS), postgres-vault (separate network), redis, redpanda, s3 (SeaweedFS, ADR-0013), localstack (KMS, S3, Secrets Manager), mailpit.
- `pnpm dev:infra` starts it; health checks for each container.
- AC: one command brings the stack up; vault DB unreachable from containers outside its network (test script proves it).

### M0.4 Logger package
- `@chronos/logger` on pino: JSON logs, request IDs, OpenTelemetry trace IDs, mandatory redaction list, allow-list mode for restricted services.
- AC: unit tests prove redacted keys never appear; `console.log` banned in services by lint.

### M0.5 Config package
- `@chronos/config`: zod-validated environment config, fails fast on missing values; secrets from env locally.
- AC: service refuses to start with invalid config; tests cover it.

### M0.6 Crypto package **[approval]**
- `@chronos/crypto`: envelope encryption (AES-256-GCM) with KMS `GenerateDataKey`/`Decrypt` via AWS SDK (LocalStack locally); helpers to encrypt/decrypt JSON payloads; constant-time comparisons; no custom primitives.
- AC: round-trip tests; tampered ciphertext fails; key-shred test proves data becomes unrecoverable.

### M0.7 Contracts package
- `packages/contracts`: Buf-managed protos (start with `disclosure/v1`), GraphQL schema file, zod event schemas; codegen scripts.
- AC: `pnpm contracts:gen` produces types; Buf lint and breaking-change check run in CI.

### M0.8 NestJS service template
- Template service with health/readiness endpoints, gRPC server, OpenTelemetry, logger, config, graceful shutdown, Dockerfile (distroless, non-root).
- AC: template builds, runs locally, image passes Trivy with no high/critical findings.

### M0.9 CI pipeline
- GitHub Actions: install, lint, typecheck, unit tests, integration tests (Testcontainers), Semgrep, gitleaks, OSV-Scanner, Trivy, Checkov; caching via Turborepo.
- AC: PRs blocked on failures; pipeline under 15 minutes for a typical PR.

### M0.10 Privacy test harness
- `pnpm test:privacy`: captures logs, emitted events, notification payloads and error responses during test runs; fails if any synthetic health marker appears.
- AC: a planted leak in a test service is detected.

### M0.11 Terraform foundations **[approval]**
- Modules: organisation SCPs, VPC, EKS, Aurora (core + vault), ElastiCache, MSK, S3/CloudFront, KMS, Secrets Manager, PrivateLink; `envs/dev` wired up. State in S3 with locking.
- AC: `terraform plan` clean for dev; Checkov passes; no apply without approval.

### M0.12 Mobile app shell
- Expo app with Expo Router, TanStack Query, i18n scaffold, design-system tokens from `packages/ui`, accessibility lint, light/dark themes.
- AC: runs on iOS simulator and Android emulator; Maestro smoke test opens the app.

---

## M1 — Identity, consent and profiles

- **M1.1 Identity service: accounts and OTP [approval]** — phone OTP with provider interface and rate limits; 18+ date-of-birth check; sessions with rotating refresh tokens. AC: OTP brute force blocked; token rotation and revocation tested.
- **M1.2 Consent records** — capture terms, privacy and separate health-processing consent with policy versions; withdrawal flow. AC: consent history queryable; health consent withdrawal triggers vault erasure request.
- **M1.3 Gateway GraphQL** — Apollo gateway with auth guard, depth/complexity limits, persisted queries, rate limiting. AC: unauthenticated access blocked except OTP mutations.
- **M1.4 Liveness verification** — Smile ID (or Onfido) integration behind an interface; store result and reference only; verified badge. AC: messaging blocked until verified; selfie retention job deletes images.
- **M1.5 Profile service** — profiles, prompts, preferences, approximate location (PostGIS), private mode. AC: other members never receive coordinates; distance rounded to at least 1 km.
- **M1.6 Photo pipeline** — signed S3 uploads, EXIF/GPS stripping, size variants, moderation status hook. AC: GPS metadata absent in stored images (test).
- **M1.7 Mobile onboarding** — sign-up, consent, privacy walkthrough before any health question, profile creation, photo upload. AC: Maestro E2E; screen reader labels pass audit.
- **M1.8 Data export and account deletion** — export bundle and erasure orchestration via events. AC: erasure completes across services within SLA in integration test.

---

## M2 — Health Vault and disclosure

- **M2.1 Vault schema and migrations [approval]** — tables per spec section 3.3; DB roles with least privilege. AC: migration tests; disclosure role cannot delete audit rows.
- **M2.2 Disclosure service core [approval]** — Upsert/Get own profile with envelope encryption; condition taxonomy seeded (broad open list + free text). AC: ciphertext only in DB; round-trip tests.
- **M2.3 Access decision engine [approval]** — `canView` per spec 4.2 with full decision-table tests; audit every decision. AC: 100% branch coverage of decision logic.
- **M2.4 Grants and revocation** — GrantDisclosure, RevokeDisclosure, ListHealthViewers. AC: revocation blocks the next view immediately.
- **M2.5 mTLS and allow-list interceptor [approval]** — per-method caller allow-list. AC: disallowed caller receives PERMISSION_DENIED in integration test.
- **M2.6 Filter eligibility with k-threshold** — per spec 4.3. AC: below-threshold returns empty; viewer must share to use filters.
- **M2.7 Erasure and crypto-shred** — EraseSubject deletes key then rows. AC: test proves data unrecoverable after erasure.
- **M2.8 Mobile health profile UX** — add conditions, choose visibility, view who has seen my health info; screen protection on these screens. AC: Maestro E2E; FLAG_SECURE verified on Android.

---

## M3 — Discovery and matching

- **M3.1 Matching service** — like, pass, match creation, unmatch, block; events emitted. AC: blocks hide both members from each other everywhere.
- **M3.2 Discovery candidate generation** — geo + age + intent filters, exclusions (seen, blocked, private mode). AC: p95 under 300 ms at seeded scale.
- **M3.3 Ranking v1** — rules-based (recency, activity, completeness, mutual preference fit). AC: deterministic tests; ranking features contain no health data.
- **M3.4 Condition-aware filtering** — integrate FilterEligibleSubjects. AC: privacy tests confirm no inference via counts.
- **M3.5 Mobile discovery UX** — cards with button alternatives to swipes, match moment, accessibility. AC: E2E like → match.

---

## M4 — Messaging (outline)
- M4.1 Spike: libsignal on React Native (native module vs audited binding) → ADR
- M4.2 Key directory and envelope relay service
- M4.3 Mobile chat (text, photos, voice notes with transcription)
- M4.4 Disclosure card flow
- M4.5 Report with forwarded decrypted messages

## M5 — Trust, safety and admin (outline)
- Moderation service, image/text classifiers, severity queues, admin console (Next.js), staff SSO + JIT access, audit views, enforcement actions, scam pattern detection, date-safety features.

## M6 — Notifications and payments (outline)
- Content-free push and email, RevenueCat entitlements, tiers (Free, Plus, Premium), paywall that never gates safety features.

## M7 — Beta hardening (outline)
- Load tests, external penetration test, DR drill, observability SLOs, legal review sign-off, private beta release.
