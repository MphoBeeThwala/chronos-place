import { loadConfig, postgresUrl } from '@chronos/config';
import pg from 'pg';
import { z } from 'zod';
import { resetSeed, seed, seededCount } from './seed.js';

/**
 * `pnpm seed [--members N] [--reset]`: synthetic members into the local core database
 * (CLAUDE.md rule 6). Only a database on this machine or in the local Docker stack is accepted.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres']);

const config = loadConfig(
  z.object({
    DATABASE_URL: postgresUrl,
    NODE_ENV: z.string().default('development'),
  }),
);
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const members = z.coerce
  .number()
  .int()
  .min(1)
  .max(1_000_000)
  .default(200_000)
  .parse(value('--members'));

const url = new URL(config.DATABASE_URL.reveal());
if (config.NODE_ENV === 'production' || !LOCAL_HOSTS.has(url.hostname)) {
  process.stderr.write('Refusing to seed: only a local development database can be seeded.\n');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url.toString() });
try {
  const existing = await seededCount(pool);
  if (existing > 0 && !flag('--reset')) {
    process.stderr.write(
      `The database already holds ${String(existing)} seeded members. Run again with --reset to replace them.\n`,
    );
    process.exitCode = 1;
  } else {
    if (existing > 0) await resetSeed(pool);
    const started = Date.now();
    const result = await seed(pool, { members });
    process.stdout.write(
      `Seeded ${String(result.members)} synthetic members and ${String(result.decisions)} likes and passes in ${String(Math.round((Date.now() - started) / 1000))} s.\n`,
    );
  }
} finally {
  await pool.end();
}
