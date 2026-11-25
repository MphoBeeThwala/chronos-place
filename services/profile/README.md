# @chronos/profile

Profiles, prompts, interests and preferences (TASKS M1.5, [ADR-0023](../../docs/adr/0023-profile-service.md)). gRPC API: `chronos.profile.v1.ProfileService` in `@chronos/contracts`. Only the gateway calls it.

## Rules it enforces

- No health data (CLAUDE.md rule 1). Members' free text is cleaned, capped and never logged.
- A profile is created by its first save, which needs a display name and an intent.
- Prompts and interests come from a fixed catalogue (`src/catalogue.ts`): up to 3 prompts, up to 5 interests.
- Preferences: ages 18–99 (18 is a hard floor, also checked by the database), distance 1–300 km.
- Location is snapped to a 0.01-degree grid (about 1 km) before it is stored, whatever the client sends, and is never returned, not even to its owner.
- Other members (`GetPublicProfiles`) see a distance in whole kilometres, at least 1, in 5 km steps above 10 km; age in whole years and the verified badge from identity (`GetMemberFacts`); never a coordinate or date of birth. Paused profiles, inactive accounts and the viewer are left out.
- Photos ([ADR-0024](../../docs/adr/0024-photo-pipeline.md)): up to 6, counting uploads still open. `CreatePhotoUpload` signs a 5-minute PUT link into the private quarantine bucket for one exact type (JPEG, PNG, WebP) and length (up to 10 MB). `CompletePhotoUpload` re-encodes it without any metadata into WebP at 320, 640 and 1280 px under random keys in the private media bucket, and always deletes the original. Photos are returned with 1-hour view links. Other members see approved photos only; the moderation hook (`src/photos/moderator.ts`) approves at once in development and holds photos as pending everywhere else until M5. Quarantine objects of abandoned uploads are cleared every minute. Logs carry ids only, never links, types or sizes.
- Private mode is a free setting. Until discovery can tell whom a member liked (M3), private profiles are left out of `GetPublicProfiles` entirely.

## Configuration

| Variable                                    | Notes                                                                                                                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                              | Core PostgreSQL with PostGIS. Run `pnpm db:migrate` first (it installs PostGIS).                                                                                                             |
| `IDENTITY_GRPC_ADDRESS`                     | host:port of identity, for ages and verified badges. Default `127.0.0.1:50052`.                                                                                                              |
| `PHOTO_UPLOAD_BUCKET`, `PHOTO_MEDIA_BUCKET` | Private buckets for quarantine and processed photos. Required outside development; unset in development keeps photos in memory (tests and API use only: the links do not load in a browser). |
| `S3_ENDPOINT`                               | SeaweedFS locally (`http://127.0.0.1:8333`); unset in AWS.                                                                                                                                   |
| `S3_PUBLIC_ENDPOINT`                        | Where browsers reach storage, if different; signs upload and view links.                                                                                                                     |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`  | SeaweedFS keys (`S3_ACCESS_KEY` and `S3_SECRET_KEY` in `tools/.env`). Unset in AWS, which uses the service's role.                                                                           |

## Tests

```sh
pnpm --filter @chronos/profile test               # unit
pnpm --filter @chronos/profile test:privacy       # leak harness
pnpm --filter @chronos/profile test:integration   # Testcontainers (Docker), or TEST_POSTGRES_URL (needs PostGIS) and TEST_S3_ENDPOINT
```
