import { randomUUID } from 'node:crypto';
import { ConditionStatus, GrantScope, Purpose, Visibility } from '@chronos/contracts/disclosure';
import { KeyDestroyedError, SubjectKeyring } from '@chronos/crypto';
import { runMigrations } from '@chronos/vault-db';
import { status } from '@grpc/grpc-js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { firstValueFrom as call } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROFILE_FIELD } from '../src/health/health-profile.service.js';
import { VaultKeyStore } from '../src/vault/key-store.js';
import { replayLedger } from '../src/vault/replay.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import {
  FakeMembers,
  FakeRelationships,
  grpcError,
  SHARED_LEDGER,
  SHARED_WRAPPER,
  startService,
  type DisclosureClient,
} from './support/service.js';

let db: TestDatabase;
let client: DisclosureClient;
let stop: () => Promise<void>;
const members = new FakeMembers();
const relationships = new FakeRelationships();

beforeAll(async () => {
  db = await startTestDatabase();
  await runMigrations(db.url);
  ({ client, stop } = await startService(db.url, undefined, { members, relationships }));
});

afterAll(async () => {
  await stop();
  await db.stop();
});

const LIVING_WITH = ConditionStatus.CONDITION_STATUS_LIVING_WITH;
const erase = (subjectAccountId: string) =>
  call(client.eraseSubject({ subjectAccountId, requestId: randomUUID() }));

/** A member with a profile, filter preferences, and a share given to a match. */
async function fullMember(): Promise<{ accountId: string; vaultId: string; match: string }> {
  const accountId = randomUUID();
  const match = randomUUID();
  members.verified.set(accountId, true);
  members.verified.set(match, true);
  relationships.matches.add(FakeRelationships.key(accountId, match));
  await call(
    client.upsertHealthProfile({
      accountId,
      profile: { conditions: [{ code: 'hiv', status: LIVING_WITH }], freeText: 'Synthetic words' },
    }),
  );
  await call(
    client.setVisibility({
      accountId,
      visibility: Visibility.VISIBILITY_CHAT_GRANT,
      filterOptIn: true,
    }),
  );
  await call(client.setFilterPreferences({ accountId, wantedConditionCodes: ['lupus'] }));
  await call(
    client.grantDisclosure({
      subjectAccountId: accountId,
      viewerAccountId: match,
      scope: GrantScope.GRANT_SCOPE_FULL,
    }),
  );
  const { rows } = await db.pool.query<{ vault_id: string }>(
    'select vault_id from vault.subject_map where account_id = $1',
    [accountId],
  );
  return { accountId, vaultId: rows[0]?.vault_id ?? '', match };
}

const count = async (table: string, vaultId: string) => {
  const { rows } = await db.pool.query<{ n: string }>(
    `select count(*) as n from vault.${table} where vault_id = $1`,
    [vaultId],
  );
  return Number(rows[0]?.n);
};

/** The member's rows as a backup would hold them. */
async function backup(vaultId: string) {
  const one = async (table: string) =>
    (await db.pool.query(`select * from vault.${table} where vault_id = $1`, [vaultId])).rows[0] as
      Record<string, unknown> | undefined;
  return {
    subjectMap: await one('subject_map'),
    subjectKeys: await one('subject_keys'),
    healthProfiles: await one('health_profiles'),
  };
}

async function restore(saved: Awaited<ReturnType<typeof backup>>) {
  for (const [table, row] of [
    ['subject_map', saved.subjectMap],
    ['subject_keys', saved.subjectKeys],
    ['health_profiles', saved.healthProfiles],
  ] as const) {
    if (row === undefined) throw new Error('nothing to restore');
    const columns = Object.keys(row);
    await db.pool.query(
      `insert into vault.${table} (${columns.join(', ')}) values (${columns.map((_, i) => `$${String(i + 1)}`).join(', ')})`,
      Object.values(row),
    );
  }
}

describe('M2.7 acceptance: unrecoverable after erasure, even from a restored backup', () => {
  it('erases everything, and a backup restored afterwards stays unreadable', async () => {
    const { accountId, vaultId } = await fullMember();
    const saved = await backup(vaultId);

    expect(await erase(accountId)).toEqual({ completed: true });
    for (const table of [
      'subject_map',
      'subject_keys',
      'health_profiles',
      'filter_preferences',
      'disclosure_grants',
    ]) {
      expect(await count(table, vaultId), table).toBe(0);
    }
    expect(SHARED_LEDGER.entries.has(vaultId)).toBe(true);
    expect(await call(client.getOwnHealthProfile({ accountId }))).toEqual({});

    // A backup from before the erasure comes back, key and all.
    await restore(saved);
    const sealed = {
      ciphertext: new Uint8Array(saved.healthProfiles?.['payload_ct'] as Buffer),
      nonce: new Uint8Array(saved.healthProfiles?.['payload_nonce'] as Buffer),
    };
    const keys = new VaultKeyStore(drizzle(db.pool));
    // Without the ledger, KMS would unwrap the restored key and the data would be back...
    const noLedger = new SubjectKeyring({ wrapper: SHARED_WRAPPER, store: keys, cacheTtlMs: 0 });
    expect(await noLedger.decrypt(vaultId, PROFILE_FIELD, sealed)).toMatchObject({
      freeText: 'Synthetic words',
    });
    // ...but the keyring checks the ledger first, so it never is.
    const withLedger = new SubjectKeyring({
      wrapper: SHARED_WRAPPER,
      store: keys,
      ledger: SHARED_LEDGER,
      cacheTtlMs: 0,
    });
    await expect(withLedger.decrypt(vaultId, PROFILE_FIELD, sealed)).rejects.toBeInstanceOf(
      KeyDestroyedError,
    );
    expect(await grpcError(call(client.getOwnHealthProfile({ accountId })))).toEqual({
      code: status.INTERNAL,
      details: 'Internal error',
    });

    // The restore replay removes the restored rows and key.
    expect(await replayLedger(drizzle(db.pool), SHARED_LEDGER)).toBeGreaterThanOrEqual(1);
    for (const table of ['subject_map', 'subject_keys', 'health_profiles']) {
      expect(await count(table, vaultId), table).toBe(0);
    }
  });
});

describe('EraseSubject', () => {
  it('is idempotent, and completes for a member with nothing in the vault', async () => {
    const { accountId } = await fullMember();
    expect(await erase(accountId)).toEqual({ completed: true });
    expect(await erase(accountId)).toEqual({ completed: true });
    expect(await erase(randomUUID())).toEqual({ completed: true });
  });

  it('finishes the job after a crash between the shred and the rows', async () => {
    const { accountId, vaultId } = await fullMember();
    // As if the process died right after keyring.shred: ledger and key done, rows still there.
    await SHARED_LEDGER.record(vaultId);
    await db.pool.query('delete from vault.subject_keys where vault_id = $1', [vaultId]);
    expect(await count('health_profiles', vaultId)).toBe(1);
    expect((await grpcError(call(client.getOwnHealthProfile({ accountId })))).code).toBe(
      status.INTERNAL,
    );

    expect(await erase(accountId)).toEqual({ completed: true });
    expect(await count('health_profiles', vaultId)).toBe(0);
  });

  it('removes shares other members gave to the erased member', async () => {
    const giver = await fullMember();
    expect(await erase(giver.match)).toEqual({ completed: true });
    const { rows } = await db.pool.query(
      'select 1 from vault.disclosure_grants where viewer_account_id = $1',
      [giver.match],
    );
    expect(rows).toEqual([]);
    // The giver's own data is untouched.
    expect(await count('health_profiles', giver.vaultId)).toBe(1);
  });

  it('keeps the audit trail, and records the erasure', async () => {
    const { accountId, vaultId, match } = await fullMember();
    await call(
      client.viewHealthProfile({
        viewerAccountId: match,
        subjectAccountId: accountId,
        purpose: Purpose.PURPOSE_PROFILE_VIEW,
      }),
    );
    await erase(accountId);
    const { rows } = await db.pool.query<{ accessor: string; purpose: string; reason: string }>(
      'select accessor, purpose, reason from vault.health_access_log where vault_id = $1 order by id',
      [vaultId],
    );
    expect(rows.at(-1)).toEqual({
      accessor: 'service:identity',
      purpose: 'erasure',
      reason: 'erased',
    });
    expect(rows.some((r) => r.reason === 'grant')).toBe(true);
  });
});
