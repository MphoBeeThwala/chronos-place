/**
 * Applies the matching migrations (forward-only) to the core database.
 * Run with `pnpm db:migrate` from the repository root, or `pnpm --filter @chronos/matching db:migrate`.
 */
import { fileURLToPath } from 'node:url';
import { loadConfigOrExit, logLevel, nodeEnv, postgresUrl } from '@chronos/config';
import { createLogger } from '@chronos/logger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { z } from 'zod';

/** Where drizzle-kit writes the SQL files; shipped with the package. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));

/** Migration bookkeeping lives outside the `matching` schema, which the first migration creates. */
export const MIGRATIONS_TABLE = {
  migrationsSchema: 'drizzle',
  migrationsTable: 'matching_migrations',
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
      DATABASE_URL: postgresUrl,
    }),
  );
  const logger = createLogger({ service: 'matching-migrate', level: config.LOG_LEVEL });
  try {
    await runMigrations(config.DATABASE_URL.reveal());
    logger.info('matching migrations applied');
  } catch (err) {
    logger.error({ err }, 'matching migrations failed');
    process.exitCode = 1;
  }
}
