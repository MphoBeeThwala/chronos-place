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

Commands for the local stack, database migrations, seed data and privacy tests are added by the tasks that build them (M0.3, M2.1, M0.10) and are documented in `CLAUDE.md` when they exist.

## Layout

Workspaces are `apps/*`, `services/*`, `restricted/*`, `packages/*` and `tools/*`. A workspace is created in the task that builds it; none are empty placeholders.

| Package                  | Purpose                                                   |
| ------------------------ | --------------------------------------------------------- |
| `@chronos/tsconfig`      | Strict shared TypeScript configs                          |
| `@chronos/eslint-config` | Shared ESLint flat config (no `console`, explained `any`) |
