# Chronos Place

Dating and connection platform for adults living with, or beyond, chronic health conditions. Privacy rules in [`CLAUDE.md`](CLAUDE.md) are non-negotiable. Product and architecture live in [`docs/`](docs): [PRD](docs/PRD.pdf), [technical spec](docs/TECHNICAL_SPEC.md), [ADRs](docs/adr), [backlog](docs/TASKS.md).

## Setup

Requirements: Node.js 22.12 or newer (see `.nvmrc`) and pnpm 10 (`corepack enable` picks the pinned version).

```sh
pnpm install
pnpm lint        # ESLint (type-aware) + Prettier check
pnpm typecheck
pnpm test
pnpm build
pnpm format      # write Prettier formatting
```

## Local infrastructure

Requires Docker with Compose v2.

```sh
pnpm dev:infra         # start the stack and wait for every health check (generates tools/.env on first run)
pnpm dev:infra:status  # container health
pnpm test:infra        # prove the Health Vault database is unreachable from outside its network
pnpm dev:infra:down    # stop; dev:infra:reset also deletes volumes
```

| Service                 | Address                          | Notes                                                      |
| ----------------------- | -------------------------------- | ---------------------------------------------------------- |
| postgres-core (PostGIS) | `127.0.0.1:5432`                 | user `chronos`, db `chronos_core`                          |
| postgres-vault          | `127.0.0.1:5433`                 | separate `vault-net`; only the disclosure service may join |
| redis                   | `127.0.0.1:6379`                 | password required                                          |
| redpanda (Kafka)        | `127.0.0.1:19092`                |                                                            |
| s3 (SeaweedFS)          | `127.0.0.1:8333`                 | S3 API with credentials                                    |
| localstack              | `127.0.0.1:4566`                 | KMS, S3, Secrets Manager (region af-south-1)               |
| mailpit                 | SMTP `1025`, UI `127.0.0.1:8025` |                                                            |

Credentials are random per machine and live in `tools/.env`, which is git-ignored. Everything binds to `127.0.0.1`.

Database migrations, seed data and privacy tests arrive with their tasks (M2.1, M0.10) and are added to `CLAUDE.md` then.

## CI

Pull requests run the checks in `.github/workflows` (see [docs/ci.md](docs/ci.md) for the gates and the branch-protection checklist). Run `pnpm check:deps` locally to check for banned third-party SDKs.

## Layout

Workspaces are `apps/*`, `services/*`, `restricted/*`, `packages/*` and `tools/*`. A workspace is created in the task that builds it; none are empty placeholders.

| Package                    | Purpose                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `@chronos/tsconfig`        | Strict shared TypeScript configs                                                          |
| `@chronos/eslint-config`   | Shared ESLint flat config (no `console`, explained `any`)                                 |
| `@chronos/logger`          | Redacting pino logger with request and trace ids, allow-list mode for restricted services |
| `@chronos/config`          | Zod-validated environment config; secrets wrapped; services exit on invalid config        |
| `@chronos/crypto`          | AES-256-GCM envelope encryption, per-subject keys wrapped by KMS, crypto-shred            |
| `@chronos/contracts`       | Protobuf (Buf, ts-proto), event schemas, GraphQL schema                                   |
| `@chronos/service-kit`     | NestJS bootstrap: probes, gRPC, graceful shutdown, safe errors, scrubbed telemetry        |
| `@chronos/privacy-harness` | Synthetic-marker leak detection across logs, events, errors, traces, URLs, notifications  |
