import type { Logger } from '@chronos/logger';
import type { ReadinessRegistry, ServiceConfig } from '@chronos/service-kit';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { profileConfig } from './config.js';
import { IdentityMemberFacts, type MemberFacts } from './identity/member-facts.js';
import { DrizzleProfileStore } from './profiles/profile-store.js';
import { ProfileService } from './profiles/profile.service.js';

export type ProfileConfig = ServiceConfig<typeof profileConfig>;

export interface ProfileRuntime {
  profiles: ProfileService;
  close: () => Promise<void>;
}

export interface RuntimeOverrides {
  /** Tests replace identity's member facts. */
  facts?: MemberFacts;
}

/** Builds the service's dependencies from validated config. */
export function createProfileRuntime(
  config: ProfileConfig,
  logger: Logger,
  readiness: ReadinessRegistry,
  overrides: RuntimeOverrides = {},
): ProfileRuntime {
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL.reveal(), max: 10 });
  readiness.register('postgres', async () => {
    await pool.query('select 1');
  });
  const facts = overrides.facts ?? new IdentityMemberFacts(config.IDENTITY_GRPC_ADDRESS);
  const profiles = new ProfileService({
    profiles: new DrizzleProfileStore(drizzle(pool)),
    facts,
    logger,
  });
  return {
    profiles,
    close: async () => {
      facts.close();
      await pool.end();
    },
  };
}
