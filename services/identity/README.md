# @chronos/identity

Accounts, phone OTP and sessions (TASKS M1.1, [ADR-0018](../../docs/adr/0018-identity-accounts-otp-sessions.md)). gRPC API: `chronos.identity.v1.IdentityService` in `@chronos/contracts`. Only the gateway calls it.

## Rules it enforces

- South African mobile numbers only (`+27`). The SMS text never names the app.
- No under-18s under any circumstance. `MINIMUM_AGE` is a code constant, the date of birth is taken once, and an under-18 account is blocked for good.
- Numbers are stored sealed (per-account key, crypto-shredded on erasure) and found by a keyed hash. Codes and refresh tokens are stored only as hashes.
- Access tokens are ES256 JWTs signed by KMS, valid for 10 minutes, with no personal data. Refresh tokens are single use and bound to the device. Reuse ends the session.

## Configuration

Shared settings come from `@chronos/service-kit`. The service's own settings (`src/config.ts`):

| Variable                           | Notes                                                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                     | Core PostgreSQL. Run `pnpm db:migrate` first.                                                                                                            |
| `REDIS_URL`                        | Rate limits and lockouts.                                                                                                                                |
| `KMS_ENDPOINT`                     | LocalStack locally (`http://127.0.0.1:4566`); unset in AWS.                                                                                              |
| `IDENTITY_DATA_KEY_ID`             | Symmetric KMS key that wraps per-account data keys.                                                                                                      |
| `ACCESS_TOKEN_KEY_ID`              | Asymmetric KMS key (`ECC_NIST_P256`, `SIGN_VERIFY`). Required outside `local`, `test` and `development`; without it, a throwaway in-process key is used. |
| `PHONE_LOOKUP_KEY`, `OTP_CODE_KEY` | Base64, at least 32 bytes each. Secrets Manager when deployed.                                                                                           |
| `OTP_SENDER`, `MAILPIT_URL`        | Only `mailpit` exists, and only in development: the service refuses to start elsewhere until an SMS provider is contracted (ADR-0006).                   |

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
