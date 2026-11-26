/**
 * `pnpm --filter @chronos/disclosure-service vault:replay-ledger`: run after restoring the vault
 * database, before the service takes traffic (ADR-0014, docs/runbooks/vault-restore.md).
 */
import {
  awsRegion,
  loadConfigOrExit,
  logLevel,
  nodeEnv,
  postgresUrl,
  httpUrl,
} from '@chronos/config';
import { createLogger } from '@chronos/logger';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { z } from 'zod';
import { replayLedger } from './vault/replay.js';
import { createLedgerClient, S3ErasureLedger } from './vault/s3-ledger.js';

const config = loadConfigOrExit(
  z.object({
    NODE_ENV: nodeEnv.default('local'),
    LOG_LEVEL: logLevel.default('info'),
    AWS_REGION: awsRegion.default('af-south-1'),
    VAULT_DATABASE_URL: postgresUrl,
    VAULT_LEDGER_BUCKET: z.string().min(3),
    S3_ENDPOINT: httpUrl.optional(),
  }),
);
const logger = createLogger({
  service: 'vault-replay-ledger',
  level: config.LOG_LEVEL,
  mode: 'allowlist',
  allowedFields: ['removed'],
});
const pool = new pg.Pool({ connectionString: config.VAULT_DATABASE_URL.reveal(), max: 2 });
try {
  const removed = await replayLedger(
    drizzle(pool),
    new S3ErasureLedger({
      client: createLedgerClient({ region: config.AWS_REGION, endpoint: config.S3_ENDPOINT }),
      bucket: config.VAULT_LEDGER_BUCKET,
    }),
  );
  logger.info({ removed }, 'erasure ledger replayed');
} catch (err) {
  logger.error({ err }, 'erasure ledger replay failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
