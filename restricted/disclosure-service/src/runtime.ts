import type { ReadinessRegistry } from '@chronos/service-kit';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { VaultKeyStore } from './vault/key-store.js';
import { SubjectDirectory } from './vault/subjects.js';

export interface DisclosureConfig {
  VAULT_DATABASE_URL: { reveal(): string };
}

export interface DisclosureRuntime {
  db: NodePgDatabase;
  subjects: SubjectDirectory;
  keys: VaultKeyStore;
  close: () => Promise<void>;
}

/** Opens the vault connection pool and the vault stores. */
export function createDisclosureRuntime(
  config: DisclosureConfig,
  readiness: ReadinessRegistry,
): DisclosureRuntime {
  const pool = new pg.Pool({ connectionString: config.VAULT_DATABASE_URL.reveal(), max: 10 });
  readiness.register('vault', async () => {
    await pool.query('select 1');
  });
  const db = drizzle(pool);
  return {
    db,
    subjects: new SubjectDirectory(db),
    keys: new VaultKeyStore(db),
    close: () => pool.end(),
  };
}
