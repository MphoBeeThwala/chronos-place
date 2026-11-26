# @chronos/identity

Accounts, phone OTP and sessions (TASKS M1.1, [ADR-0018](../../docs/adr/0018-identity-accounts-otp-sessions.md)). gRPC API: `chronos.identity.v1.IdentityService` in `@chronos/contracts`. The gateway calls it; the profile service calls `GetMemberFacts` only (whole-year ages and verified badges of active members, never a date of birth). With `include_activity`, which only discovery ranking uses, it adds a coarse activity bucket from sessions (today, this week, this month, longer; [ADR-0027](../../docs/adr/0027-ranking-v1.md)), never shown to anyone.

## Rules it enforces

- South African mobile numbers only (`+27`). The SMS text never names the app.
- No under-18s under any circumstance. `MINIMUM_AGE` is a code constant, the date of birth is taken once, and an under-18 account is blocked for good.
- Numbers are stored sealed (per-account key, crypto-shredded on erasure) and found by a keyed hash. Codes and refresh tokens are stored only as hashes.
- Consent ([ADR-0020](../../docs/adr/0020-consent-records.md)): terms and privacy come before the date of birth. History is append-only. Withdrawing health consent queues erasure of health data in the vault, and withdrawing terms or privacy starts account deletion.
- Liveness verification ([ADR-0022](../../docs/adr/0022-liveness-verification.md)): needs an active account and the separate biometric consent. The vendor gets only the images and a random per-attempt reference. Captures are sealed under the account key, kept 30 days for appeals, then deleted with the vendor's copy (sooner if the consent is withdrawn). Limits: 5 attempts an hour, 10 a day; human review is offered after 3 failures. Development uses a fake vendor that passes every capture; elsewhere verification stays off until a vendor adapter is supplied and counsel has approved the consent text.
- Account deletion ([ADR-0025](../../docs/adr/0025-account-deletion-and-data-export.md)): a fresh code to the account's own number confirms it. Deletion codes live apart from sign-in codes, so neither can stand in for the other, and they share every sign-in limit on the same number. Once confirmed there is no undo: the account becomes pending erasure, the number is freed for a new account, every session ends, health erasure is queued and `account.erasure_requested` is published. Each service then deletes its data and confirms with `account.erasure_confirmed`. Once every service in `ERASURE_CONFIRMING_SERVICES` has confirmed, and the verification worker has deleted any captures and vendor copies (it needs the key for that), identity shreds the account's data key and deletes its sessions, consents, codes and verification records. Only the bare id is left, with status `erased`, and `account.erased` is published. The database refuses an `erased` account that still holds a number or a date of birth. Erasure still waiting after 7 days is counted on the `erasure_overdue` gauge, which has no labels and is exported once a metrics pipeline exists, and logged as a warning with the count only.
- Access tokens are ES256 JWTs signed by KMS, valid for 10 minutes, with no personal data. Refresh tokens are single use and bound to the device. Reuse ends the session.

## Configuration

Shared settings come from `@chronos/service-kit`. The service's own settings (`src/config.ts`):

| Variable                                                          | Notes                                                                                                                                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                    | Core PostgreSQL. Run `pnpm db:migrate` first.                                                                                                                              |
| `REDIS_URL`                                                       | Rate limits and lockouts.                                                                                                                                                  |
| `KMS_ENDPOINT`                                                    | LocalStack locally (`http://127.0.0.1:4566`); unset in AWS.                                                                                                                |
| `IDENTITY_DATA_KEY_ID`                                            | Symmetric KMS key that wraps per-account data keys.                                                                                                                        |
| `ACCESS_TOKEN_KEY_ID`                                             | Asymmetric KMS key (`ECC_NIST_P256`, `SIGN_VERIFY`). Required outside `local`, `test` and `development`; without it, a throwaway in-process key is used.                   |
| `PHONE_LOOKUP_KEY`, `OTP_CODE_KEY`                                | Base64, at least 32 bytes each. Secrets Manager when deployed.                                                                                                             |
| `OTP_SENDER`, `MAILPIT_URL`                                       | Only `mailpit` exists, and only in development: the service refuses to start elsewhere until an SMS provider is contracted (ADR-0006).                                     |
| `KAFKA_BROKERS`                                                   | Kafka brokers for the outbox relay (ADR-0019), locally Redpanda at `127.0.0.1:19092`. Unset: events wait in `identity.outbox`, and erasure confirmations are not received. |
| `ERASURE_CONFIRMING_SERVICES`                                     | Services that must confirm before an account is erased (ADR-0025), comma-separated. Default `profile,matching`; each new service that stores member data joins the list.   |
| `LIVENESS_PROVIDER`                                               | `fake` (default, development only) or `smile-id` (ADR-0022). Outside development `smile-id` is refused while the biometric consent text is a draft.                        |
| `SMILE_ID_PARTNER_ID`, `SMILE_ID_API_KEY`, `SMILE_ID_ENVIRONMENT` | Smile ID credentials and `sandbox` (default) or `production`. The API key is a secret: Secrets Manager when deployed.                                                      |
| `CAPTURE_BUCKET`, `S3_ENDPOINT`                                   | Bucket for sealed selfie captures (30 days). `S3_ENDPOINT` is SeaweedFS locally (`http://127.0.0.1:8333`); unset in AWS.                                                   |

Local setup, with the stack running (`pnpm dev:infra`):

```sh
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=af-south-1
aws --endpoint-url http://127.0.0.1:4566 kms create-key --query KeyMetadata.KeyId --output text            # IDENTITY_DATA_KEY_ID
aws --endpoint-url http://127.0.0.1:4566 kms create-key --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY \
  --query KeyMetadata.KeyId --output text                                                                    # ACCESS_TOKEN_KEY_ID
openssl rand -base64 32   # PHONE_LOOKUP_KEY, and again for OTP_CODE_KEY
```

Codes arrive in the Mailpit inbox (http://127.0.0.1:8025), never in logs.

## Tests

```sh
pnpm --filter @chronos/identity test               # unit
pnpm --filter @chronos/identity test:privacy       # leak harness
pnpm --filter @chronos/identity test:integration   # Testcontainers (Docker), or TEST_POSTGRES_URL / TEST_REDIS_URL
```
