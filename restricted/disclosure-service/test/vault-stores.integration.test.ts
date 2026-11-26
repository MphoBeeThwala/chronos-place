import { randomUUID } from 'node:crypto';
import { KeyDestroyedError, SubjectKeyring } from '@chronos/crypto';
import { InMemoryKeyWrapper } from '@chronos/crypto/testing';
import { runMigrations } from '@chronos/vault-db';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VaultKeyStore } from '../src/vault/key-store.js';
import { SubjectDirectory } from '../src/vault/subjects.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';

let db: TestDatabase;
/** Connects as the runtime role, so every query here runs with the service's real privileges. */
let servicePool: pg.Pool;
let subjects: SubjectDirectory;
let keys: VaultKeyStore;

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
  servicePool = new pg.Pool({ connectionString: db.url, options: '-c role=disclosure_service' });
  const vault = drizzle(servicePool);
  subjects = new SubjectDirectory(vault);
  keys = new VaultKeyStore(vault);
});

afterAll(async () => {
  await servicePool.end();
  await db.stop();
});

const keyring = () =>
  new SubjectKeyring({ wrapper: new InMemoryKeyWrapper(), store: keys, cacheTtlMs: 0 });

describe('the pool really runs as the service role', () => {
  it('reports disclosure_service as the current role', async () => {
    const { rows } = await servicePool.query<{ role: string }>('select current_role as role');
    expect(rows[0]?.role).toBe('disclosure_service');
  });
});

describe('SubjectDirectory', () => {
  it('finds nothing for an account with nothing in the vault', async () => {
    expect(await subjects.find(randomUUID())).toBeUndefined();
  });

  it('creates one random vault id per account, also under concurrent calls', async () => {
    const accountId = randomUUID();
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => subjects.findOrCreate(accountId)),
    );
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBe(accountId);
    expect(await subjects.find(accountId)).toBe(ids[0]);
  });
});

describe('VaultKeyStore with SubjectKeyring', () => {
  it('stores one wrapped key per member and round-trips a sealed value', async () => {
    const vaultId = await subjects.findOrCreate(randomUUID());
    const ring = keyring();
    const sealed = await ring.encrypt(vaultId, 'health_profile', { marker: 'synthetic' });
    expect(await ring.decrypt(vaultId, 'health_profile', sealed)).toEqual({ marker: 'synthetic' });

    const { rows } = await db.pool.query<{ n: string }>(
      'select count(*) as n from vault.subject_keys where vault_id = $1',
      [vaultId],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('keeps the first key when two writers race', async () => {
    const vaultId = await subjects.findOrCreate(randomUUID());
    const record = (byte: number) => ({ wrapped: new Uint8Array([byte]), keyId: 'test-key' });
    const results = await Promise.all([
      keys.putIfAbsent(vaultId, record(1)),
      keys.putIfAbsent(vaultId, record(2)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = await keys.get(vaultId);
    expect(stored?.wrapped).toEqual(record(results[0] ? 1 : 2).wrapped);
  });

  it('records the rotation time when a key is re-wrapped', async () => {
    const vaultId = await subjects.findOrCreate(randomUUID());
    await keyring().encrypt(vaultId, 'health_profile', {});
    await keys.replace(vaultId, { wrapped: new Uint8Array([9]), keyId: 'test-key-v2' });
    const { rows } = await db.pool.query<{ kms_key_arn: string; rotated: boolean }>(
      'select kms_key_arn, rotated_at is not null as rotated from vault.subject_keys where vault_id = $1',
      [vaultId],
    );
    expect(rows[0]).toEqual({ kms_key_arn: 'test-key-v2', rotated: true });
  });

  it('makes sealed values unrecoverable once the key is shredded', async () => {
    const vaultId = await subjects.findOrCreate(randomUUID());
    const ring = keyring();
    const sealed = await ring.encrypt(vaultId, 'health_profile', { marker: 'synthetic' });
    await ring.shred(vaultId);
    expect(await keys.get(vaultId)).toBeUndefined();
    await expect(ring.decrypt(vaultId, 'health_profile', sealed)).rejects.toBeInstanceOf(
      KeyDestroyedError,
    );
  });
});
