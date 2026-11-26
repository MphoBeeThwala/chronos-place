import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { loadConfig } from '@chronos/config';
import pg from 'pg';
import { z } from 'zod';

/** Same major version as the postgres-vault service in tools/docker-compose.yml. */
const IMAGE = 'postgres:17-alpine';

export interface TestDatabase {
  url: string;
  pool: pg.Pool;
  stop: () => Promise<void>;
}

/**
 * A fresh, empty database for a test file. Uses Testcontainers (needs Docker), or an existing
 * server when TEST_VAULT_POSTGRES_URL points at one (a database is created and dropped per file).
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const { TEST_VAULT_POSTGRES_URL: external } = loadConfig(
    z.object({ TEST_VAULT_POSTGRES_URL: z.string().optional() }),
  );
  if (external !== undefined && external !== '') {
    const name = `disclosure_test_${String(Date.now())}_${String(Math.floor(Math.random() * 1e6))}`;
    const admin = new pg.Client({ connectionString: external });
    await admin.connect();
    await admin.query(`create database ${name}`);
    await admin.end();
    const url = new URL(external);
    url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString() });
    return {
      url: url.toString(),
      pool,
      stop: async () => {
        await pool.end();
        const cleanup = new pg.Client({ connectionString: external });
        await cleanup.connect();
        await cleanup.query(`drop database if exists ${name}`);
        await cleanup.end();
      },
    };
  }

  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(IMAGE).start();
  const pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  return {
    url: container.getConnectionUri(),
    pool,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
