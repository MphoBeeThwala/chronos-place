/**
 * TASKS M1.8 acceptance: erasure completes across services within the SLA.
 *
 * Identity and profile run as they do in a deployment: their real runtimes, with their own
 * outbox relay, Kafka subscribers and erasure timer, sharing one core database (each in its own
 * schema), Redis, Kafka and S3 storage. Only what this test cannot have is replaced: the KMS key
 * wrapper (in memory), the SMS sender (recorded) and identity's member facts for profile.
 *
 * A synthetic member signs up, consents, gives a date of birth, makes a profile and uploads a
 * real photo. They then delete their account with the texted code, and the test waits for
 * identity to mark the account erased: profile must have received the request over Kafka,
 * deleted every row and file and confirmed, and identity must have finished. Then it checks that
 * nothing about the member is left in either schema or in storage.
 */
import { randomBytes } from 'node:crypto';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { TOPICS } from '@chronos/contracts/events';
import { SubjectKeyring } from '@chronos/crypto';
import { InMemoryKeyWrapper } from '@chronos/crypto/testing';
import { ensureTopics } from '@chronos/events';
import { createLogger } from '@chronos/logger';
import { ReadinessRegistry, serviceConfigSchema } from '@chronos/service-kit';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityConfig } from '../../../services/identity/src/config.js';
import { DrizzleAccountKeyStore } from '../../../services/identity/src/crypto/account-key-store.js';
import { runMigrations as identityMigrations } from '../../../services/identity/src/db/migrate.js';
import { ERASURE_INTERVAL_MS } from '../../../services/identity/src/runtime.js';
import { IDENTITY_KEY_PURPOSE } from '../../../services/identity/src/otp/otp.service.js';
import {
  createIdentityRuntime,
  type IdentityRuntime,
} from '../../../services/identity/src/runtime.js';
import { startTestBroker } from '../../../services/identity/test/support/broker.js';
import {
  startTestDatabase,
  type TestDatabase,
} from '../../../services/identity/test/support/database.js';
import { RecordingOtpSender } from '../../../services/identity/test/support/otp-fakes.js';
import { startTestRedis, type TestRedis } from '../../../services/identity/test/support/redis.js';
import { profileConfig } from '../../../services/profile/src/config.js';
import { runMigrations as profileMigrations } from '../../../services/profile/src/db/migrate.js';
import { allSizes, uploadKey } from '../../../services/profile/src/photos/photo.service.js';
import {
  createProfileRuntime,
  type ProfileRuntime,
} from '../../../services/profile/src/runtime.js';
import { syntheticJpeg } from '../../../services/profile/test/support/photo-fakes.js';
import { FakeMemberFacts } from '../../../services/profile/test/support/profile-fakes.js';
import { startTestS3, type TestS3 } from '../../../services/profile/test/support/s3.js';

/** ADR-0025 f: minutes, not days. One erasure-timer period, plus room for the hops between. */
const SLA_MS = ERASURE_INTERVAL_MS + 30_000;
/** A synthetic number per run, so nothing from an earlier run applies. */
const PHONE = `082${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
const client = { deviceId: 'acceptance-device', ip: '192.0.2.10' };
const silent = createLogger({ service: 'acceptance', destination: { write: () => undefined } });

let db: TestDatabase;
let redis: TestRedis;
let s3: TestS3;
let broker: { brokers: string[]; stop: () => Promise<void> };
let identity: IdentityRuntime;
let profile: ProfileRuntime;
const sender = new RecordingOtpSender();

beforeAll(async () => {
  db = await startTestDatabase();
  await identityMigrations(db.url);
  await profileMigrations(db.url);
  redis = await startTestRedis();
  s3 = await startTestS3();
  broker = await startTestBroker();
  await ensureTopics({ brokers: broker.brokers, clientId: 'acceptance-admin' }, TOPICS);
  const kafka = broker.brokers.join(',');

  identity = createIdentityRuntime(
    serviceConfigSchema(identityConfig).parse({
      NODE_ENV: 'test',
      SERVICE_NAME: 'identity',
      DATABASE_URL: db.url,
      REDIS_URL: redisUrl(redis),
      IDENTITY_DATA_KEY_ID: 'alias/synthetic',
      PHONE_LOOKUP_KEY: randomBytes(32).toString('base64'),
      OTP_CODE_KEY: randomBytes(32).toString('base64'),
      KAFKA_BROKERS: kafka,
      ERASURE_CONFIRMING_SERVICES: 'profile',
    }),
    silent,
    new ReadinessRegistry(),
    {
      sender,
      // KMS stands in memory; the wrapped keys still live in identity.account_keys.
      keyring: new SubjectKeyring({
        wrapper: new InMemoryKeyWrapper(),
        store: new DrizzleAccountKeyStore(drizzle(db.pool)),
        purpose: IDENTITY_KEY_PURPOSE,
        cacheTtlMs: 0,
      }),
    },
  );
  profile = createProfileRuntime(
    serviceConfigSchema(profileConfig).parse({
      NODE_ENV: 'test',
      SERVICE_NAME: 'profile',
      DATABASE_URL: db.url,
      KAFKA_BROKERS: kafka,
      PHOTO_UPLOAD_BUCKET: s3.uploadBucket,
      PHOTO_MEDIA_BUCKET: s3.mediaBucket,
      S3_ENDPOINT: s3.endpoint,
      S3_ACCESS_KEY_ID: s3.accessKeyId,
      S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    }),
    silent,
    new ReadinessRegistry(),
    { facts: new FakeMemberFacts() },
  );
});

afterAll(async () => {
  await profile.close();
  await identity.close();
  await broker.stop();
  await s3.stop();
  await redis.stop();
  await db.stop();
});

/** The helper hands back a client; identity's config wants its URL. */
function redisUrl({ redis: r }: TestRedis): string {
  const { host, port, password } = r.options;
  const auth = password ? `:${encodeURIComponent(password)}@` : '';
  return `redis://${auth}${host ?? '127.0.0.1'}:${String(port ?? 6379)}`;
}

/**
 * Sign-in and deletion codes share the number's one-minute resend cooldown (ADR-0025 a). A real
 * member deletes long after signing up; here, a minute "passes" by clearing it.
 */
async function aMinutePasses(): Promise<void> {
  const keys = await redis.redis.keys('identity:otp:*:cooldown:*');
  if (keys.length > 0) await redis.redis.del(...keys);
}

/** Every row anywhere that still names the account, per table. */
async function leftovers(accountId: string): Promise<Record<string, number>> {
  const { rows } = await db.pool.query<{
    table_schema: string;
    table_name: string;
    column_name: string;
  }>(
    `select table_schema, table_name, column_name from information_schema.columns
      where table_schema in ('identity', 'profile')
        and column_name in ('account_id', 'subject_id')`,
  );
  const found: Record<string, number> = {};
  for (const r of rows) {
    const { rows: n } = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from "${r.table_schema}"."${r.table_name}" where "${r.column_name}" = $1`,
      [accountId],
    );
    if ((n[0]?.n ?? 0) > 0) found[`${r.table_schema}.${r.table_name}`] = n[0]?.n ?? 0;
  }
  return found;
}

async function objects(bucket: string, prefix: string): Promise<number> {
  const listed = await s3.client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  return listed.KeyCount ?? 0;
}

describe('M1.8 acceptance: account erasure across services', () => {
  it('erases everything about the member within the SLA', async () => {
    // Sign up: code, consents, date of birth (onboarding steps 1 and 2).
    const challenge = await identity.otp.requestOtp(PHONE, client);
    const verified = await identity.otp.verifyOtp(challenge.challengeId, sender.lastCode());
    const { account } = await identity.accounts.signIn(verified);
    const accountId = account.id;
    await identity.sessions.open(accountId, client.deviceId);
    for (const { type, version } of identity.consents.currentPolicies()) {
      if (type === 'terms' || type === 'privacy') {
        await identity.consents.record(accountId, type, version, true);
      }
    }
    await identity.accounts.setDateOfBirth(accountId, { year: 1990, month: 4, day: 2 });

    // A profile with a real photo, processed into every size, and an upload left open.
    await profile.profiles.update(accountId, { displayName: 'Thuli', intent: 'dating' });
    const jpeg = await syntheticJpeg();
    const done = await profile.photos.createUpload(accountId, 'image/jpeg', jpeg.length);
    const put = await fetch(done.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: jpeg,
    });
    expect(put.ok).toBe(true);
    const photo = await profile.photos.completeUpload(accountId, done.uploadId);
    const open = await profile.photos.createUpload(accountId, 'image/jpeg', jpeg.length);
    await fetch(open.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: jpeg,
    });

    expect(Object.keys(await leftovers(accountId)).length).toBeGreaterThan(5);
    expect(await objects(s3.mediaBucket, `photos/${photo.id}/`)).toBe(allSizes(photo.id).length);
    expect(await objects(s3.uploadBucket, uploadKey(open.uploadId))).toBe(1);

    // Delete, with the texted code.
    await aMinutePasses();
    const deletion = await identity.deletion.requestCode(accountId, client);
    const started = Date.now();
    await identity.deletion.deleteAccount(accountId, deletion.challengeId, sender.lastCode());

    // Wait for identity to finish: that needs profile's confirmation, over Kafka.
    let status = '';
    while (Date.now() - started < SLA_MS) {
      const { rows } = await db.pool.query<{ status: string }>(
        'select status from identity.accounts where id = $1',
        [accountId],
      );
      status = rows[0]?.status ?? '';
      if (status === 'erased') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const tookMs = Date.now() - started;
    expect(status, `erased within ${String(SLA_MS / 1000)} s`).toBe('erased');

    // Nothing else in either schema names the member, except the health-erasure request, which
    // stays queued (only the bare id) until the Disclosure Service can act on it in M2 (ADR-0025).
    expect(await leftovers(accountId)).toEqual({ 'identity.vault_erasure_requests': 1 });
    // The account row is the bare tombstone: its id, status and times.
    const { rows: tomb } = await db.pool.query(
      `select phone_lookup, phone_ciphertext, phone_nonce, date_of_birth, verified_at
         from identity.accounts where id = $1`,
      [accountId],
    );
    expect(tomb[0]).toEqual({
      phone_lookup: null,
      phone_ciphertext: null,
      phone_nonce: null,
      date_of_birth: null,
      verified_at: null,
    });
    // Every photo file and the open upload are gone from storage.
    expect(await objects(s3.mediaBucket, `photos/${photo.id}/`)).toBe(0);
    expect(await objects(s3.uploadBucket, uploadKey(open.uploadId))).toBe(0);
    // The number is free again: signing in now would make a new account.
    await aMinutePasses();
    const again = await identity.otp.requestOtp(PHONE, { ...client, deviceId: 'second-device' });
    expect(again.challengeId).toBeTruthy();
    expect(tookMs).toBeLessThan(SLA_MS);
  });
});
