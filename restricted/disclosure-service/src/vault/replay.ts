import { subjectKeys, subjectMap } from '@chronos/vault-db';
import { inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { ErasureLedger } from './s3-ledger.js';

const BATCH = 500;

/**
 * Restore replay (ADR-0014 step 4): after any vault restore, and before the service takes traffic,
 * delete the key and every row of each subject in the erasure ledger. Returns how many subjects
 * still had data in the restored database.
 */
export async function replayLedger(db: NodePgDatabase, ledger: ErasureLedger): Promise<number> {
  let removed = 0;
  let batch: string[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    // Keys first: a key without its subject row is still a key.
    await db.delete(subjectKeys).where(inArray(subjectKeys.vaultId, batch));
    const rows = await db
      .delete(subjectMap)
      .where(inArray(subjectMap.vaultId, batch))
      .returning({ vaultId: subjectMap.vaultId });
    removed += rows.length;
    batch = [];
  };
  for await (const vaultId of ledger.list()) {
    batch.push(vaultId);
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  return removed;
}
