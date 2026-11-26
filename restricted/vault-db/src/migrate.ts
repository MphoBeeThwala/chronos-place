/**
 * Applies the Health Vault migrations (forward-only) to the vault database.
 * Run with `pnpm db:migrate:vault` from the repository root. VAULT_DATABASE_URL must reach the
 * vault database, which is only reachable from inside its own network (ADR-0002).
 */
import { fileURLToPath } from 'node:url';
import { loadConfigOrExit, logLevel, nodeEnv, postgresUrl } from '@chronos/config';
import { createLogger } from '@chronos/logger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { z } from 'zod';

/** Where drizzle-kit writes the SQL files; shipped with the package. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/** Migration bookkeeping lives outside the `vault` schema, which the first migration creates. */
export const MIGRATIONS_TABLE = {
  migrationsSchema: 'drizzle',
  migrationsTable: 'vault_migrations',
};

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER, ...MIGRATIONS_TABLE });
  } finally {
    await pool.end();
  }
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const config = loadConfigOrExit(
    z.object({
      NODE_ENV: nodeEnv.default('local'),
      LOG_LEVEL: logLevel.default('info'),
      VAULT_DATABASE_URL: postgresUrl,
    }),
  );
  const logger = createLogger({ service: 'vault-migrate', level: config.LOG_LEVEL });
  try {
    await runMigrations(config.VAULT_DATABASE_URL.reveal());
    logger.info('vault migrations applied');
  } catch (err) {
    logger.error({ err }, 'vault migrations failed');
    process.exitCode = 1;
  }
}
