import { KMSClient } from '@aws-sdk/client-kms';
import { KmsKeyWrapper, SubjectKeyring } from '@chronos/crypto';
import type { ReadinessRegistry } from '@chronos/service-kit';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { HealthProfileService } from './health/health-profile.service.js';
import { ConditionTaxonomy } from './health/taxonomy.js';
import { AccessLog } from './vault/access-log.js';
import { VaultKeyStore } from './vault/key-store.js';
import { SubjectDirectory } from './vault/subjects.js';

export interface DisclosureConfig {
  VAULT_DATABASE_URL: { reveal(): string };
  VAULT_DATA_KEY_ID: string;
  KMS_ENDPOINT?: string | undefined;
  AWS_REGION: string;
}

/** Test seams: a keyring with an in-memory wrapper instead of KMS. */
export interface RuntimeOverrides {
  keyring?: (keys: VaultKeyStore) => SubjectKeyring;
}

export interface DisclosureRuntime {
  db: NodePgDatabase;
  subjects: SubjectDirectory;
  keys: VaultKeyStore;
  taxonomy: ConditionTaxonomy;
  profiles: HealthProfileService;
  close: () => Promise<void>;
}

/** Opens the vault connection pool and builds the vault stores and services. */
export function createDisclosureRuntime(
  config: DisclosureConfig,
  readiness: ReadinessRegistry,
  overrides: RuntimeOverrides = {},
): DisclosureRuntime {
  const pool = new pg.Pool({ connectionString: config.VAULT_DATABASE_URL.reveal(), max: 10 });
  readiness.register('vault', async () => {
    await pool.query('select 1');
  });
  const db = drizzle(pool);
  const subjects = new SubjectDirectory(db);
  const keys = new VaultKeyStore(db);
  const keyring =
    overrides.keyring?.(keys) ??
    new SubjectKeyring({
      wrapper: new KmsKeyWrapper({
        keyId: config.VAULT_DATA_KEY_ID,
        client: new KMSClient({
          region: config.AWS_REGION,
          ...(config.KMS_ENDPOINT ? { endpoint: config.KMS_ENDPOINT } : {}),
        }),
      }),
      store: keys,
    });
  const taxonomy = new ConditionTaxonomy(db);
  const profiles = new HealthProfileService({
    db,
    subjects,
    keyring,
    taxonomy,
    accessLog: new AccessLog(db),
  });
  return { db, subjects, keys, taxonomy, profiles, close: () => pool.end() };
}
