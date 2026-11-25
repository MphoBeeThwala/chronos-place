import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashOperation, PersistedOperations } from '../src/limits/persisted-operations.js';
import { QUERY_LIMITS } from '../src/limits/query-limits.js';
import { RATE_LIMITS, type RateLimitStore } from '../src/limits/rate-limit.js';
import { AccountStatus, FakeIdentity } from './support/fake-identity.js';
import { codes, gql, startGateway, type TestGateway } from './support/gateway.js';

const ACTIVE = '55555555-5555-4555-8555-555555555555';

/** Reports a chosen count per key prefix, and remembers the keys it saw. */
class ScriptedStore implements RateLimitStore {
  readonly keys: string[] = [];
  counts: Record<string, number> = {};
  hit(key: string): Promise<{ count: number; resetSeconds: number }> {
    this.keys.push(key);
    const prefix = key.split(':')[0] ?? '';
    return Promise.resolve({ count: this.counts[prefix] ?? 1, resetSeconds: 42 });
  }
}

const identity = new FakeIdentity();
const store = new ScriptedStore();
let gateway: TestGateway;

beforeAll(async () => {
  await identity.start();
  identity.statuses.set(ACTIVE, AccountStatus.ACCOUNT_STATUS_ACTIVE);
  gateway = await startGateway(identity, { rateLimitStore: store });
});

afterAll(async () => {
  await gateway.service.shutdown('test');
  await identity.stop();
});

describe('rate limits (decision a: 300/min per IP, 600/min per account)', () => {
  it('has the approved numbers', () => {
    expect(RATE_LIMITS.perIp).toEqual({ limit: 300, windowSeconds: 60 });
    expect(RATE_LIMITS.perAccount).toEqual({ limit: 600, windowSeconds: 60 });
    expect(RATE_LIMITS.photoUploadsPerAccount).toEqual({ limit: 20, windowSeconds: 3600 });
  });

  it('refuses the request after the per-IP limit, with a retry hint and HTTP 429', async () => {
    store.counts = { ip: 301 };
    const response = await gql(
      gateway.url,
      'mutation { requestOtp(phone: "0820000001") { challengeId } }',
    );
    store.counts = {};
    expect(response.status).toBe(429);
    expect(response.body.errors?.[0]).toEqual({
      message: 'Too many requests. Try again shortly.',
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 42 },
    });
  });

  it('applies the per-account limit to signed-in members', async () => {
    store.counts = { ip: 1, account: 601 };
    const cookie = `chronos_access=${await identity.token(ACTIVE)}`;
    const response = await gql(gateway.url, '{ account { id } }', { cookie });
    store.counts = {};
    expect(codes(response)).toEqual(['RATE_LIMITED']);
    expect(store.keys.some((k) => k === `account:${ACTIVE}`)).toBe(true);
  });

  it('never puts an IP address in a key', async () => {
    store.keys.length = 0;
    await gql(gateway.url, '{ __typename }');
    for (const key of store.keys) expect(key).toMatch(/^ip:[0-9a-f]{64}$/);
  });
});

describe('query limits', () => {
  it('refuses queries deeper than 10', async () => {
    const deep =
      '{ __schema { types { fields { type { ofType { ofType { ofType { ofType { ofType { ofType { name } } } } } } } } } } }';
    const response = await gql(gateway.url, deep);
    expect(response.body.errors?.[0]?.extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  it('refuses queries whose estimated cost is too high, before they run', async () => {
    const cookie = `chronos_access=${await identity.token(ACTIVE)}`;
    const response = await gql(
      gateway.url,
      '{ feed(first: 1000) { edges { node { id displayName photos { url } prompts { answer } } } } }',
      { cookie },
    );
    expect(response.body.errors?.[0]).toEqual({
      message: 'Query too complex.',
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it('accepts a normal page', async () => {
    const cookie = `chronos_access=${await identity.token(ACTIVE)}`;
    const response = await gql(gateway.url, '{ feed { edges { node { id photos { url } } } } }', {
      cookie,
    });
    expect(codes(response)).toEqual(['NOT_AVAILABLE']);
  });

  it('refuses oversized queries and variables before parsing them', async () => {
    const long = `{ __typename ${'__typename '.repeat(QUERY_LIMITS.maxQueryLength / 10)}}`;
    expect((await gql(gateway.url, long)).status).toBe(413);
    const big = await gql(gateway.url, 'query ($x: String) { __typename }', {
      variables: { x: 'a'.repeat(QUERY_LIMITS.maxVariablesBytes) },
    });
    expect(big.status).toBe(413);
  });
});

describe('approved operations (decision b)', () => {
  const approved = 'mutation SignIn($p: String!) { requestOtp(phone: $p) { challengeId } }';
  const operations = new PersistedOperations({ [hashOperation(approved)]: approved });
  const persisted = (hash: string) => ({ persistedQuery: { version: 1, sha256Hash: hash } });

  async function post(url: string, body: object) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        errors?: { message: string; extensions?: { code?: string } }[];
        data?: unknown;
      },
    };
  }

  describe('enforced, as outside development', () => {
    const strictIdentity = new FakeIdentity();
    let strict: TestGateway;

    beforeAll(async () => {
      await strictIdentity.start();
      strictIdentity.handlers.set('requestOtp', () => ({
        challengeId: 'c',
        expiresAt: new Date(),
        retryAfterSeconds: 60,
      }));
      strict = await startGateway(strictIdentity, {
        persistedOperations: operations,
        enforcePersistedOperations: true,
      });
    });

    afterAll(async () => {
      await strict.service.shutdown('test');
      await strictIdentity.stop();
    });

    it('refuses free-form queries', async () => {
      const response = await post(strict.url, { query: '{ __typename }' });
      expect(response.status).toBe(400);
      expect(response.body.errors?.[0]).toEqual({
        message: 'Only approved operations are accepted.',
        extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' },
      });
    });

    it('refuses an unknown hash', async () => {
      const response = await post(strict.url, {
        extensions: persisted(hashOperation('{ __typename }')),
      });
      expect(response.body.errors?.[0]?.extensions?.code).toBe('PERSISTED_QUERY_NOT_FOUND');
    });

    it('runs an approved operation by hash', async () => {
      const response = await post(strict.url, {
        operationName: 'SignIn',
        variables: { p: '0820000001' },
        extensions: persisted(hashOperation(approved)),
      });
      expect(response.body.data).toEqual({ requestOtp: { challengeId: 'c' } });
    });

    it('runs the manifest text, not text the client sends alongside an approved hash', async () => {
      const response = await post(strict.url, {
        query: 'mutation { deleteAccount(challengeId: "c", code: "123456") { id } }',
        operationName: 'SignIn',
        variables: { p: '0820000001' },
        extensions: persisted(hashOperation(approved)),
      });
      expect(response.body.data).toEqual({ requestOtp: { challengeId: 'c' } });
    });
  });

  it('accepts free-form queries in development and test', async () => {
    expect(codes(await gql(gateway.url, '{ __typename }'))).toEqual([]);
  });
});
