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

## Status

- M2.2 (in progress): the vault stores and readiness are done. Saving and reading your own
  profile, and the condition list, come next.

## Tests

```
pnpm --filter @chronos/disclosure-service test               # unit
pnpm --filter @chronos/disclosure-service test:integration   # Testcontainers, or TEST_VAULT_POSTGRES_URL
```

Integration tests connect with `-c role=disclosure_service`, so they run with the service's real
privileges.
