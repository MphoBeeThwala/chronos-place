# ADR-0001: Stack baseline and scope boundaries

## Decision
Keep the stack in `CLAUDE.md` unchanged: TypeScript everywhere, pnpm + Turborepo, NestJS services, Apollo GraphQL at the gateway, gRPC between services, Kafka events, Postgres/PostGIS with Drizzle, Redis, Expo React Native, Next.js consoles, AWS af-south-1 on EKS with Terraform and Argo CD.

## Why
- One language end to end lets a small team share zod schemas, types and tooling, and avoids a polyglot rewrite later. The PRD's "NestJS or Go" is closed in favour of NestJS.
- The PRD scale target (1M registered, 150k DAU, 10x messaging burst) fits Aurora, Redis and Kafka comfortably. Nothing here needs re-architecture to reach it; scaling is replicas, read replicas and partitions.
- The stack choices are boring and widely hireable in South Africa.

## Deliberately not built at GA
- OpenSearch (ADR-0007), learned ranking, a service-per-feature split beyond the PRD list, multi-region active-active.
- Video calls (LiveKit, self-hosted) are P1, GA + 6 months. Design the messaging match-state API so calls can reuse it.

## Consequences
New frameworks, databases or major dependencies need a new ADR.
