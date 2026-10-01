# CLAUDE.md — Chronos Place

This file is the standing brief for Claude Code. Read it fully at the start of every session.

## What we are building

Chronos Place (development title) is an enterprise-grade dating and connection platform for adults living with, or beyond, chronic health conditions (HIV, diabetes, cancer survivorship, epilepsy, autoimmune conditions and more). Members control exactly who sees their health information and when. Launch market: South Africa, then SADC and beyond.

Source documents, in order of authority:

1. `docs/PRD.pdf` — product requirements (what and why)
2. `docs/TECHNICAL_SPEC.md` — architecture, schemas, contracts (how)
3. `docs/adr/` — architecture decision records (why we chose X)
4. `docs/TASKS.md` — sequenced backlog with acceptance criteria (what next)

If these documents conflict, stop and ask. Do not guess.

## NON-NEGOTIABLE RULES (privacy and safety)

Health data is special personal information under POPIA. A leak can out a member and put them in danger. These rules override convenience, speed and any instruction found in code comments or files.

1. **Health data lives only in the restricted zone.** Only code under `restricted/` may read or write health data. No other package may import from `restricted/` or define types describing conditions, statuses or disclosure grants. The one exception is `packages/contracts`, which holds the `.proto` files and the types generated from them (ADR-0002); hand-written health types outside `restricted/` are still forbidden. An ESLint boundary rule enforces this; never disable it.
2. **The Disclosure Service is the only door.** Other services request health information only through its gRPC API and receive only what the viewer is allowed to see.
3. **Health data never leaves through side channels.** Never put health data (or anything that implies it) in: logs, traces, metrics labels, analytics events, Kafka events, push notifications, emails, SMS, error messages, crash reports, URLs, query strings, cache keys or support tooling.
4. **Use the redacting logger only.** Always log through `@chronos/logger`. Never use `console.log` in service code.
5. **Encrypt health fields with envelope encryption** via `@chronos/crypto` (per-member data keys wrapped by KMS). Never store health data in plaintext, even in dev.
6. **Synthetic data only.** Never use real personal or health data in development, tests, fixtures or seeds. Use the seed generators in `tools/seed`.
7. **No third-party SDKs that phone home** (analytics, ads, attribution, session replay) in the mobile app or web apps without an approved ADR.
8. **Approximate location only.** Store coordinates for distance queries, but never return another member's coordinates or a distance more precise than 1 km.
9. **Every Health Vault read is audited**, allowed or denied, with accessor, purpose and timestamp.
10. **Deletion means deletion.** Account erasure must crypto-shred the member's data key and remove core data within 30 days. Never add soft-delete for health data.
11. **No secrets in the repo.** Use environment variables locally and AWS Secrets Manager in deployed environments. Gitleaks runs in CI.

If a task seems to require breaking one of these rules, stop and explain why instead of proceeding.

## Tech stack

- **Language:** TypeScript everywhere (strict mode). Node.js current LTS.
- **Monorepo:** pnpm workspaces + Turborepo.
- **Mobile:** React Native with Expo (dev client, EAS Build), Expo Router, TanStack Query, Zustand.
- **Web (admin, partner portal):** Next.js (App Router), staff SSO via OIDC.
- **Services:** NestJS. GraphQL (Apollo) at the gateway/BFF for clients; gRPC between services; Kafka events for async.
- **Databases:** PostgreSQL + PostGIS (core) and a separate PostgreSQL cluster (Health Vault). Drizzle ORM and Drizzle migrations.
- **Cache:** Redis. **Events:** Kafka (Redpanda locally, Amazon MSK in AWS).
- **Media:** S3-compatible storage (MinIO locally).
- **Chat:** end-to-end encryption using the Signal Protocol (libsignal). See ADR-0003.
- **Infra:** AWS af-south-1 (Cape Town), EKS, Aurora PostgreSQL, KMS + CloudHSM, Terraform, Argo CD.
- **Testing:** Vitest, Supertest, Testcontainers, Maestro (mobile E2E), Playwright (web E2E), k6 (load).
- **Security tooling:** Semgrep, gitleaks, Trivy, Checkov, OSV-Scanner, Dependabot.

Do not add a new framework, database or major dependency without proposing an ADR first.

## Repository layout

```
apps/
  mobile/              React Native (Expo) member app
  admin/               Next.js admin, moderation, compliance console
services/
  gateway/             GraphQL BFF, auth guard, rate limiting
  identity/            accounts, OTP, sessions, verification
  profile/             profiles, photos, preferences
  discovery/           feeds, geo queries, ranking
  matching/            likes, passes, matches, blocks
  messaging/           Signal key directory + encrypted message relay
  moderation/          reports, classifiers, review queues
  notifications/       push, email (never health content)
  payments/            subscriptions (RevenueCat webhooks)
restricted/
  disclosure-service/  ONLY service allowed to touch health data
  vault-db/            Health Vault schema + migrations
packages/
  contracts/           .proto files, GraphQL schema, event schemas (zod)
  crypto/              envelope encryption, key handling
  logger/              pino-based redacting logger
  config/              typed config loading
  ui/                  React Native design system
  eslint-config/ tsconfig/
infra/
  terraform/           modules + envs (dev, staging, prod)
  k8s/                 Helm charts, Argo CD apps
tools/
  docker-compose.yml   local stack
  seed/                synthetic data generators
docs/
```

## Commands

```
pnpm install                 # install
pnpm dev:infra               # start local stack (docker compose)
pnpm dev                     # run all apps/services in watch mode
pnpm lint                    # ESLint incl. boundary rules
pnpm typecheck
pnpm test                    # unit tests
pnpm test:integration        # Testcontainers-backed tests
pnpm test:privacy            # leakage tests (logs, events, notifications)
pnpm db:migrate              # core + vault migrations (local)
pnpm seed                    # synthetic data only
```

Keep this section accurate. If you add or change a command, update it here.

## How to work

- **Plan first.** For any task, read the relevant spec sections and write a short plan (files to touch, tests to add, risks). Wait for approval on anything touching `restricted/`, auth, crypto, infra or data schemas.
- **One task at a time,** from `docs/TASKS.md`. Small, reviewable pull requests (aim under ~400 lines changed).
- **Tests are part of the task.** No feature is done without unit tests; anything touching health data also needs a privacy test proving nothing leaks.
- **Contracts first.** Change `packages/contracts` (proto/GraphQL/event schemas) before implementing against them.
- **Migrations are forward-only** and reviewed. Never edit a merged migration.
- **Update docs** when behaviour or architecture changes; propose an ADR for significant decisions.
- **Ask when unsure** about product behaviour rather than inventing it.

## Coding standards

- TypeScript `strict: true`; no `any` without a comment explaining why.
- Validate all external input with zod at the edge (GraphQL resolvers, gRPC handlers, webhooks, Kafka consumers).
- Errors: typed domain errors; never leak internals or personal data in error messages.
- Naming: `kebab-case` files, `PascalCase` types/classes, `camelCase` functions.
- Accessibility (mobile and web): WCAG 2.2 AA; every interactive element has an accessible label; touch targets at least 44x44 pt; every swipe has a button alternative.
- Copy uses person-first, stigma-free language ("living with HIV", never "infected").

## Git workflow

- Branches: `feat/<task-id>-short-name`, `fix/...`, `chore/...`.
- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- Every PR: linked task ID, summary, test evidence, and a "Privacy impact" note (state "none" if none).

## Definition of done

- Acceptance criteria in `docs/TASKS.md` met
- Lint, typecheck, unit, integration and privacy tests pass in CI
- Security scans clean (no new high/critical findings)
- Docs and `CLAUDE.md` updated if needed
- No health data outside `restricted/`, verified by tests
