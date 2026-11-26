# @chronos/disclosure-service

The only door to the Health Vault (CLAUDE.md rules 1 and 2, ADR-0002). Other services reach health
information only through its gRPC API (`packages/contracts/proto/chronos/disclosure/v1`) and get
back only what the viewer may see.

- **Restricted zone:** it starts with the allow-list logger and **no telemetry** (ADR-0016). The
  kit refuses to start it if tracing was preloaded.
- **Database:** `VAULT_DATABASE_URL` connects as a login in the `disclosure_service` role
  (`restricted/vault-db`). Members appear only by a pseudonymous vault id.
- **Keys:** each member's data key is wrapped by KMS and stored in `vault.subject_keys`. Deleting
  that row is the crypto-shred.

## What it does so far (M2.2)

- `UpsertHealthProfile` saves a member's whole profile, sealed with their data key and bound to
  their vault id. `expected_version` (0 to create) stops two devices overwriting each other:
  a mismatch is `ABORTED`.
- Rules: codes must be active in the condition list, or `other` with the member's own words; no
  duplicates; a status is required; at most 10 conditions; own words and note up to 500
  characters each. Errors use fixed messages and never repeat what was sent.
- `GetOwnHealthProfile` records `account:<id>` / `profile_view` / `allow` / `self` in the access
  log **before** returning anything; if that fails, nothing is returned. A member with nothing
  in the vault gets an empty answer, and no vault id is created for them.
- `ListConditionTaxonomy` lists active entries in label order, "other" last.
- Every other call answers `UNIMPLEMENTED` until its task (M2.3 to M2.7).

**Known limit:** a save must use active codes only. When an entry is first switched off, a member
who still has it will need to remove it before saving again. That needs a decision before any
entry is deactivated.

## Configuration

`VAULT_DATABASE_URL`, `VAULT_DATA_KEY_ID` (the KMS key that wraps members' data keys) and,
locally, `KMS_ENDPOINT` for the KMS stand-in.

## Tests

```
pnpm --filter @chronos/disclosure-service test               # unit
pnpm --filter @chronos/disclosure-service test:integration   # Testcontainers, or TEST_VAULT_POSTGRES_URL
pnpm --filter @chronos/disclosure-service test:privacy       # leakage: logs and gRPC errors
```

Integration tests connect with `-c role=disclosure_service`, so they run with the service's real
privileges.
