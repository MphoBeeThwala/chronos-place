import { KMSClient } from '@aws-sdk/client-kms';
import { KmsKeyWrapper, SubjectKeyring } from '@chronos/crypto';
import {
  grpcClientCredentials,
  type ClientTlsConfig,
  type ReadinessRegistry,
} from '@chronos/service-kit';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from '@chronos/logger';
import pg from 'pg';
import { IdentityMemberFacts, type MemberFacts } from './access/member-facts.js';
import { MatchingNotYetAvailable, type Relationships } from './access/relationships.js';
import { SharingService } from './access/sharing.service.js';
import { ViewService } from './access/view.service.js';
import { ViewersService } from './access/viewers.service.js';
import { FilterService } from './health/filter.service.js';
import { HealthProfileService } from './health/health-profile.service.js';
import { ConditionTaxonomy } from './health/taxonomy.js';
import { AccessLog } from './vault/access-log.js';
import { Grants } from './vault/grants.js';
import { VaultKeyStore } from './vault/key-store.js';
import { SubjectDirectory } from './vault/subjects.js';

export interface DisclosureConfig extends ClientTlsConfig {
  VAULT_DATABASE_URL: { reveal(): string };
  VAULT_DATA_KEY_ID: string;
  KMS_ENDPOINT?: string | undefined;
  AWS_REGION: string;
  IDENTITY_GRPC_ADDRESS: string;
}

/** Test seams: an in-memory KMS wrapper, fake identity and matching. */
export interface RuntimeOverrides {
  keyring?: (keys: VaultKeyStore) => SubjectKeyring;
  members?: MemberFacts;
  relationships?: Relationships;
  now?: () => number;
}

export interface DisclosureRuntime {
  db: NodePgDatabase;
  subjects: SubjectDirectory;
  keys: VaultKeyStore;
  taxonomy: ConditionTaxonomy;
  profiles: HealthProfileService;
  views: ViewService;
  sharing: SharingService;
  viewers: ViewersService;
  filters: FilterService;
  close: () => Promise<void>;
}

/** Opens the vault connection pool and builds the vault stores and services. */
export function createDisclosureRuntime(
  config: DisclosureConfig,
  readiness: ReadinessRegistry,
  overrides: RuntimeOverrides = {},
  logger?: Logger,
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
  const accessLog = new AccessLog(db);
  const profiles = new HealthProfileService({ db, subjects, keyring, taxonomy, accessLog });
  const members =
    overrides.members ??
    new IdentityMemberFacts(
      config.IDENTITY_GRPC_ADDRESS,
      grpcClientCredentials(config, 'identity'),
    );
  const grants = new Grants(db);
  const relationships = overrides.relationships ?? new MatchingNotYetAvailable();
  const views = new ViewService({
    db,
    subjects,
    grants,
    relationships,
    members,
    profiles,
    accessLog,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  return {
    db,
    subjects,
    keys,
    taxonomy,
    profiles,
    views,
    sharing: new SharingService({ db, subjects, grants, relationships, members }),
    viewers: new ViewersService(db, subjects, accessLog),
    filters: new FilterService({
      db,
      subjects,
      keyring,
      taxonomy,
      accessLog,
      ...(logger ? { logger } : {}),
    }),
    close: async () => {
      members.close();
      await pool.end();
    },
  };
}
