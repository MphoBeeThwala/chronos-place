# @chronos/profile

Profiles, prompts, interests and preferences (TASKS M1.5, [ADR-0023](../../docs/adr/0023-profile-service.md)). gRPC API: `chronos.profile.v1.ProfileService` in `@chronos/contracts`. Only the gateway calls it.

## Rules it enforces

- No health data (CLAUDE.md rule 1). Members' free text is cleaned, capped and never logged.
- A profile is created by its first save, which needs a display name and an intent.
- Prompts and interests come from a fixed catalogue (`src/catalogue.ts`): up to 3 prompts, up to 5 interests.
- Preferences: ages 18–99 (18 is a hard floor, also checked by the database), distance 1–300 km.
- Location is snapped to a 0.01-degree grid (about 1 km) before it is stored, whatever the client sends, and is never returned, not even to its owner.
- Other members (`GetPublicProfiles`) see a distance in whole kilometres, at least 1, in 5 km steps above 10 km; age in whole years and the verified badge from identity (`GetMemberFacts`); never a coordinate or date of birth. Paused profiles, inactive accounts and the viewer are left out.
- Private mode is a free setting. Until discovery can tell whom a member liked (M3), private profiles are left out of `GetPublicProfiles` entirely.

## Configuration

| Variable                | Notes                                                                            |
| ----------------------- | -------------------------------------------------------------------------------- |
| `DATABASE_URL`          | Core PostgreSQL with PostGIS. Run `pnpm db:migrate` first (it installs PostGIS). |
| `IDENTITY_GRPC_ADDRESS` | host:port of identity, for ages and verified badges. Default `127.0.0.1:50052`.  |

## Tests

```sh
pnpm --filter @chronos/profile test               # unit
pnpm --filter @chronos/profile test:privacy       # leak harness
pnpm --filter @chronos/profile test:integration   # Testcontainers (Docker), or TEST_POSTGRES_URL (needs PostGIS)
```
