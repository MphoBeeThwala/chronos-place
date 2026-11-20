# ADR-0018: Identity: accounts, phone OTP and sessions

Status: Accepted (2026-11-20, product owner approved the M1.1 plan). Items marked **needs external input** stay open.

## Product decisions (approved)
- **Date of birth comes straight after the code is verified.** A new account starts as `PENDING_ONBOARDING` and can only finish onboarding until `SetDateOfBirth` passes the 18+ rule. The spec's `date_of_birth NOT NULL` becomes nullable for this reason.
- **No under-18s, under any circumstance** (product owner, 2026-11-20). The minimum age of 18 is a constant in code, not configuration: no flag, environment variable, role, support tool or admin action can lower or bypass it. The date of birth can be set once. An under-18 date makes the account `INELIGIBLE` for good and revokes its sessions: another date cannot be tried, and the number cannot open a new account. The date given is not stored. The account's data key is shredded, so the sealed number becomes unrecoverable, and only the keyed lookup hash is kept, to block the number. Whether that hash may be kept, and for how long, **needs counsel** (POPIA treats children's data as special).
- **South African mobile numbers only at launch:** `+27` followed by 9 digits starting 6, 7 or 8. Other numbers fail with `INVALID_ARGUMENT`. Wider coverage comes with SADC expansion.
- **Limits** (`services/identity/src/otp/limits.ts`): per number, 3 codes per 15 minutes, 10 per day and at least 60 seconds between codes; 5 tries per code; 10 failed tries across a number's codes within 24 hours lock it for 1 hour, and a successful sign-in clears the count. Per IP, 20 codes per hour; per device, 10 codes per hour. Every request counts, including refused ones. Counters and locks live in Redis under keyed hashes, never the number, IP or device id. Tries per code are counted in Postgres in the same statement that checks the limit, so parallel guesses cannot exceed it.
- **Tokens never reach browser JavaScript.** The GraphQL `Session` type carries no tokens; the gateway (M1.3) sets them as `httpOnly`, `Secure`, `SameSite=Strict` cookies, and `refreshSession` reads the refresh cookie.

## Technical decisions
- **Data lives in the core database, in a Postgres schema `identity`** owned by the identity service's role. No other service reads it; they ask identity over gRPC. Migrations are Drizzle, forward-only, run with `pnpm db:migrate`.
- **Phone numbers are Confidential** (spec 2): sealed with `@chronos/crypto` under a per-account data key (`SubjectKeyring`, KMS purpose `identity`), so account erasure crypto-shreds the number. A keyed lookup hash (HMAC-SHA256, key from Secrets Manager) finds the account and enforces uniqueness without decrypting. Logs show the last 2 digits at most (ADR-0006).
- **The number is sealed once, at code request.** `RequestOtp` picks a prospective account id and seals the number under it. If verification creates the account, it uses that id and the ciphertext as-is (the AAD binds subject and field, so nothing is re-encrypted). Otherwise the prospective key is shredded when the challenge expires.
- **Codes:** 6 digits from `crypto.randomInt`, 5-minute expiry, stored only as HMAC-SHA256 over challenge id and code with a server key, compared in constant time. A database leak alone does not reveal codes. SMS text is fixed and never names the app (ADR-0006).
- **Access tokens:** JWT, ES256, signed by a KMS asymmetric key, 10 minutes. Claims: `iss`, `aud`, `sub` (account id), `sid` (session id), `iat`, `exp`, `jti`. No phone number, status or other personal data. The gateway verifies them locally with keys from `GetSigningKeys`.
- **Refresh tokens:** 32 random bytes, stored as SHA-256, single use, 30 days, bound to a hash of the client's device id. Each refresh issues a new pair. Presenting a refresh token that was already exchanged revokes the whole session (theft detection). Sign-out and "sign out everywhere" revoke sessions; access tokens die within 10 minutes, and the gateway checks the session on sensitive actions.
- **Parallel refreshes:** each refresh token is exchanged at most once, atomically. A second request racing with the same token counts as reuse and ends the session, so clients (the gateway, M1.3) must refresh one request at a time per session. A refresh token used from a device other than the one it was issued to also ends the session.
- **Account state is checked on refresh:** only `PENDING_ONBOARDING` and `ACTIVE` accounts keep sessions. An ineligible or suspended account's next refresh fails and ends the session.
- **Errors are generic.** No response says whether a number already has an account.

## Consequences
- M1.1 ships in four parts: contracts, schema and migrations; OTP; accounts and sessions; events and integration and privacy tests.
- The real SMS provider is still pending its commercial terms (ADR-0006, **needs external input**). Locally, codes go to Mailpit and never to logs.
- The lookup-hash key cannot be rotated without rehashing every account. Rotation is a planned job, not a config change.
- An erasure ledger for identity's keys (ADR-0014 applies to identity too) arrives with M1.8.
