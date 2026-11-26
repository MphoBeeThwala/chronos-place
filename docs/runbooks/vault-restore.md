# Runbook: restoring the Health Vault database

**Why this matters.** A vault backup taken before a member was erased still holds that member's wrapped data key. Restored as-is, it would bring their health data back (ADR-0014). The erasure ledger, which is kept outside the vault and its backups, lists every erased member. **Replaying the ledger before the service takes traffic is not optional.**

Owner: the on-call engineer for the restricted account. Two people take part: one runs the steps, the other checks each one. This keeps the four-eyes rule for the restricted zone.

## Before you start

- **Backup age:** confirm the backup or point-in-time target is **no older than 30 days**. Retention is capped at 30 days, so an older backup should not exist; if one does, stop and escalate.
- **Ledger bucket:** confirm the erasure ledger bucket (`VAULT_LEDGER_BUCKET`) is reachable from the restricted network, and that its Object Lock settings are unchanged.
- **Traffic:** keep the Disclosure Service at **zero replicas**, or out of the mesh, until step 4 has passed.

## Steps

1. **Restore** the vault cluster from the chosen backup into the restricted account, with the usual infrastructure tooling.
2. **Migrate** the restored database to the current schema: `pnpm db:migrate:vault` with `VAULT_DATABASE_URL` pointing at it. Migrations are forward-only.
3. **Replay the ledger**, running as the `disclosure_service` role with the same `VAULT_LEDGER_BUCKET` and `AWS_REGION` as the service (plus `S3_ENDPOINT` locally):

   ```
   VAULT_DATABASE_URL=… VAULT_LEDGER_BUCKET=… pnpm --filter @chronos/disclosure-service vault:replay-ledger
   ```

   It logs how many restored subjects it removed (`removed`). A non-zero number is expected after restoring an older backup.
4. **Verify:**
   - Run the replay a second time; it must report `removed: 0`.
   - For three ledger entries picked at random, `select count(*) from vault.subject_keys where vault_id = …` must return 0.
   - Keep the output.
5. **Return to service:** scale the Disclosure Service back up and confirm `/readyz` is ready. It checks both the vault and the ledger.
6. **Record** the restore, both replay outputs and who did each step in the incident or drill log.

## If something goes wrong

- **The replay fails part-way:** run it again. It is idempotent. Do not take traffic until a full run and the verify run succeed.
- **The ledger is unreachable:** do not take traffic. The keyring refuses keys it cannot check, but the restored rows must still be removed.

## Quarterly drill (ADR-0014)

- Restore the latest backup into a **separate** non-production restricted environment.
- Erase one synthetic test member there, created with the seed generators and never a real member.
- Restore a backup taken before that erasure, then follow steps 2 to 4.
- Confirm the test member's data cannot be read through the service.
- Record the drill, then tear the environment down.
