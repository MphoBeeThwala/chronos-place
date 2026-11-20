import { randomBytes, randomUUID } from 'node:crypto';
import { KeyDestroyedError, SubjectKeyring } from '@chronos/crypto';
import { InMemoryKeyWrapper } from '@chronos/crypto/testing';
import { createLogger } from '@chronos/logger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAccountKeyStore } from '../src/crypto/account-key-store.js';
import { runMigrations } from '../src/db/migrate.js';
import { DrizzleChallengeStore, type NewChallenge } from '../src/otp/challenge-store.js';
import { CodeHasher } from '../src/otp/code.js';
import { KeyedHasher } from '../src/otp/keyed-hash.js';
import { IDENTITY_KEY_PURPOSE, OtpService, PHONE_FIELD } from '../src/otp/otp.service.js';
import { RedisRateLimitStore } from '../src/otp/rate-limiter.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import { client, RecordingOtpSender, syntheticPhone } from './support/otp-fakes.js';
import { startTestRedis, type TestRedis } from './support/redis.js';

let db: TestDatabase;
let redis: TestRedis;

beforeAll(async () => {
  [db, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
  await runMigrations(db.url);
});

afterAll(async () => {
  await Promise.all([db.stop(), redis.stop()]);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const limiter = () => new RedisRateLimitStore(redis.redis, `test:${randomUUID()}`);

function newChallenge(expiresInMs = 300_000): NewChallenge {
  return {
    id: randomUUID(),
    phoneLookup: randomBytes(32),
    prospectiveAccountId: randomUUID(),
    phoneCiphertext: randomBytes(40),
    phoneNonce: randomBytes(12),
    codeHash: randomBytes(32),
    expiresAt: new Date(Date.now() + expiresInMs),
  };
}

describe('RedisRateLimitStore', () => {
  it('counts hits in a window that always has an expiry', async () => {
    const store = limiter();
    expect((await store.hit('k', 60)).count).toBe(1);
    const second = await store.hit('k', 60);
    expect(second.count).toBe(2);
    expect(second.resetSeconds).toBeGreaterThan(0);
    expect(second.resetSeconds).toBeLessThanOrEqual(60);
  });

  it('starts a new window once the old one expires', async () => {
    const store = limiter();
    await store.hit('short', 1);
    await store.hit('short', 1);
    await sleep(1100);
    expect((await store.hit('short', 1)).count).toBe(1);
  });

  it('repairs a counter that lost its expiry', async () => {
    const prefix = `test:${randomUUID()}`;
    await redis.redis.set(`${prefix}:orphan`, '5');
    const { count, resetSeconds } = await new RedisRateLimitStore(redis.redis, prefix).hit(
      'orphan',
      30,
    );
    expect(count).toBe(6);
    expect(resetSeconds).toBe(30);
    expect(await redis.redis.ttl(`${prefix}:orphan`)).toBeGreaterThan(0);
  });

  it('sets, reads and clears locks', async () => {
    const store = limiter();
    expect(await store.ttl('lock')).toBe(0);
    await store.set('lock', 3600);
    expect(await store.ttl('lock')).toBeGreaterThan(3590);
    await store.delete('lock');
    expect(await store.ttl('lock')).toBe(0);
  });

  it('counts concurrent hits exactly', async () => {
    const store = limiter();
    const results = await Promise.all(Array.from({ length: 50 }, () => store.hit('burst', 60)));
    expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
  });
});

describe('DrizzleChallengeStore', () => {
  const store = () => new DrizzleChallengeStore(drizzle(db.pool));

  it('finds an open challenge and hides expired ones', async () => {
    const open = newChallenge();
    const expired = newChallenge(-1000);
    await store().insert(open);
    await store().insert(expired);
    expect((await store().findOpen(open.id, new Date()))?.attempts).toBe(0);
    expect(await store().findOpen(expired.id, new Date())).toBeUndefined();
  });

  it('never counts more than the allowed tries, even in parallel', async () => {
    const challenge = newChallenge();
    await store().insert(challenge);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store().recordAttempt(challenge.id, 5, new Date())),
    );
    expect(results.filter((r) => r !== undefined)).toHaveLength(5);
    const { rows } = await db.pool.query<{ attempts: number }>(
      'select attempts from identity.otp_challenges where id = $1',
      [challenge.id],
    );
    expect(rows[0]?.attempts).toBe(5);
  });

  it('lets exactly one request use a challenge', async () => {
    const challenge = newChallenge();
    await store().insert(challenge);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store().consume(challenge.id, new Date())),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store().findOpen(challenge.id, new Date())).toBeUndefined();
  });
});

describe('DrizzleAccountKeyStore with SubjectKeyring', () => {
  it('seals under a stored key and crypto-shreds on delete', async () => {
    const keyring = new SubjectKeyring({
      wrapper: new InMemoryKeyWrapper(),
      store: new DrizzleAccountKeyStore(drizzle(db.pool)),
      purpose: IDENTITY_KEY_PURPOSE,
      cacheTtlMs: 0,
    });
    const subject = randomUUID();
    const sealed = await keyring.encrypt(subject, PHONE_FIELD, syntheticPhone());
    await expect(keyring.decrypt(subject, PHONE_FIELD, sealed)).resolves.toBe(syntheticPhone());
    await keyring.shred(subject);
    await expect(keyring.decrypt(subject, PHONE_FIELD, sealed)).rejects.toBeInstanceOf(
      KeyDestroyedError,
    );
  });

  it('keeps the first key when two writers race', async () => {
    const keys = new DrizzleAccountKeyStore(drizzle(db.pool));
    const subject = randomUUID();
    const record = { wrapped: randomBytes(48), keyId: 'k1' };
    expect(await keys.putIfAbsent(subject, record)).toBe(true);
    expect(await keys.putIfAbsent(subject, { wrapped: randomBytes(48), keyId: 'k2' })).toBe(false);
    expect((await keys.get(subject))?.keyId).toBe('k1');
  });
});

describe('OtpService on real stores', () => {
  it('signs in with the right code and refuses a reused one', async () => {
    const orm = drizzle(db.pool);
    const sender = new RecordingOtpSender();
    const service = new OtpService({
      challenges: new DrizzleChallengeStore(orm),
      limits: limiter(),
      sender,
      keyring: new SubjectKeyring({
        wrapper: new InMemoryKeyWrapper(),
        store: new DrizzleAccountKeyStore(orm),
        purpose: IDENTITY_KEY_PURPOSE,
        cacheTtlMs: 0,
      }),
      lookupHasher: new KeyedHasher(randomBytes(32)),
      codeHasher: new CodeHasher(randomBytes(32)),
      logger: createLogger({ service: 'identity-test', destination: { write: () => undefined } }),
    });
    const { challengeId } = await service.requestOtp(syntheticPhone(7), client(7));
    const verified = await service.verifyOtp(challengeId, sender.lastCode());
    expect(verified.prospectiveAccountId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(service.verifyOtp(challengeId, sender.lastCode())).rejects.toThrow(
      'Code not accepted.',
    );
  });
});
