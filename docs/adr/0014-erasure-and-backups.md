# ADR-0014: Erasure must survive backup restores

## Context
Technical spec 4.4 said crypto-shredding makes backups unreadable "because the DEK is gone". That holds only if the wrapped data key is gone from the backup too. A backup taken before erasure still contains the member's wrapped key, and KMS will unwrap it for the vault's role. Restoring that backup would bring erased health data back. The PRD requires erasure including backups, and POPIA expects erased data to stay erased.

## Decision
1. **Erasure ledger.** When a subject is erased, their pseudonymous vault ID is appended to a ledger stored outside the Health Vault database and its backups (target: an S3 Object Lock bucket in the restricted account, written by the disclosure service role only). It holds no health data.
2. **Keyring check.** `SubjectKeyring` consults the ledger before every key use and refuses to unwrap, rewrap or create a key for a listed subject (`KeyDestroyedError`).
3. **Shred order.** Ledger entry first, then delete the wrapped key, then delete vault rows. A crash between steps leaves the subject unreadable, never half-readable.
4. **Restore procedure.** Any restore of the vault database must replay the ledger (delete rows and keys for every listed subject) before the service accepts traffic. This is part of the quarterly restore drill.
5. **Retention.** Vault backups and point-in-time recovery are kept for at most 30 days, so a restored backup is never older than the erasure window.

## Consequences
- M0.6 ships the ledger interface and the keyring check, with tests proving both a restored backup stays unreadable and (without a ledger) why it would not.
- M2.7 implements the ledger store, the restore replay script and the drill.
- The ledger is the one place a pseudonymous ID outlives the member. It cannot be linked to an account without the vault's `subject_map`, which is deleted at erasure.
