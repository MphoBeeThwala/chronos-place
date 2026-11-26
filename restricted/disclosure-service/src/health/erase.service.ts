import type { SubjectKeyring } from '@chronos/crypto';
import { disclosureGrants, subjectMap } from '@chronos/vault-db';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AccessLog } from '../vault/access-log.js';
import type { SubjectDirectory } from '../vault/subjects.js';

export interface EraseDeps {
  db: NodePgDatabase;
  subjects: SubjectDirectory;
  keyring: SubjectKeyring;
  accessLog: AccessLog;
}

/**
 * EraseSubject (M2.7, ADR-0014, CLAUDE.md rule 10). Order: ledger entry, then the wrapped key
 * (both by `keyring.shred`), then the rows. A crash between steps leaves the member unreadable,
 * never half-readable, and a retry finishes the job. Idempotent: erasing again completes at once.
 */
export class EraseService {
  readonly #deps: EraseDeps;

  constructor(deps: EraseDeps) {
    this.#deps = deps;
  }

  async erase(accountId: string): Promise<void> {
    const { db, subjects, keyring, accessLog } = this.#deps;
    // Shares other members gave to this account name it as the viewer: they go too.
    await db.delete(disclosureGrants).where(eq(disclosureGrants.viewerAccountId, accountId));

    const vaultId = await subjects.find(accountId);
    if (vaultId === undefined) return; // nothing held, or already erased

    await keyring.shred(vaultId);
    // Cascades to the health profile, filter preferences and the member's own grants.
    await db.delete(subjectMap).where(eq(subjectMap.vaultId, vaultId));
    // Kept: the pseudonymous record that an erasure happened (retention: counsel to set).
    await accessLog.record({
      vaultId,
      accessor: 'service:identity',
      purpose: 'erasure',
      decision: 'allow',
      reason: 'erased',
    });
  }
}
