# @chronos/vault-db

Health Vault schema, forward-only migrations and database roles. Restricted zone (ADR-0002): only
code under `restricted/` may import this package, and the Disclosure Service is its only user.

The tables and roles are described in `docs/TECHNICAL_SPEC.md` §3.3. In short:

- Health content is stored only as ciphertext sealed with the member's data key.
- Members appear only as a pseudonymous `vault_id`. `subject_map` is the one link to an account.
- `disclosure_service` is the runtime role. It cannot change or delete audit rows. The grants
  forbid it, and a trigger refuses changes for every role, the owner included.
- Both roles are created without login. Credentials come from infrastructure, never from here.

## Commands

```
pnpm db:migrate:vault                                   # apply to the local vault (stack up)
pnpm --filter @chronos/vault-db db:generate             # new migration from src/schema.ts
pnpm --filter @chronos/vault-db exec drizzle-kit generate --custom --name <name>  # hand-written SQL
pnpm --filter @chronos/vault-db test:integration        # Testcontainers, or TEST_VAULT_POSTGRES_URL
```

A new table needs its grants in a new hand-written migration, and the privilege test in
`test/migrations.integration.test.ts` pins the full grant matrix, so a missing or extra grant
fails the build. Migrations are forward-only: never edit one that has been merged.
