# @chronos/profile

Profiles, prompts, interests and preferences (TASKS M1.5, [ADR-0023](../../docs/adr/0023-profile-service.md)). gRPC API: `chronos.profile.v1.ProfileService` in `@chronos/contracts`. Only the gateway calls it.

## Rules it enforces

- No health data (CLAUDE.md rule 1). Members' free text is cleaned, capped and never logged.
- A profile is created by its first save, which needs a display name and an intent.
- Prompts and interests come from a fixed catalogue (`src/catalogue.ts`): up to 3 prompts, up to 5 interests.
- Preferences: ages 18–99 (18 is a hard floor, also checked by the database), distance 1–300 km.
- Location is stored snapped to about 1 km and is never returned (arrives with M1.5 part 2).
- Private mode is a free setting; discovery enforces it (M3).

## Configuration

| Variable       | Notes                                                                            |
| -------------- | -------------------------------------------------------------------------------- |
| `DATABASE_URL` | Core PostgreSQL with PostGIS. Run `pnpm db:migrate` first (it installs PostGIS). |

## Tests

```sh
pnpm --filter @chronos/profile test               # unit
pnpm --filter @chronos/profile test:privacy       # leak harness
pnpm --filter @chronos/profile test:integration   # Testcontainers (Docker), or TEST_POSTGRES_URL (needs PostGIS)
```
