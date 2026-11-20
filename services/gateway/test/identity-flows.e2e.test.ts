import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRefreshLock } from '../src/auth/refresh-lock.js';
import { AccountStatus, FakeIdentity, GrpcFailure } from './support/fake-identity.js';
import {
  codes,
  gql,
  startGateway,
  type GraphQLResponse,
  type TestGateway,
} from './support/gateway.js';

const identity = new FakeIdentity();
const lock = new InMemoryRefreshLock();
let gateway: TestGateway;
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
let refreshCount = 0;

/** The Cookie header a browser would send after these responses. */
function jar(...responses: GraphQLResponse[]): string {
  const cookies = new Map<string, string>();
  for (const r of responses)
    for (const c of r.setCookies) {
      const [pair = ''] = c.split(';');
      const [name = '', value = ''] = pair.split('=');
      if (/Max-Age=0/.test(c)) cookies.delete(name);
      else cookies.set(name, value);
    }
  return [...cookies].map(([n, v]) => `${n}=${v}`).join('; ');
}
const named = (r: GraphQLResponse, name: string) =>
  r.setCookies.find((c) => c.startsWith(`${name}=`));

beforeAll(async () => {
  await identity.start();
  gateway = await startGateway(identity, { refreshLock: lock });
});

afterAll(async () => {
  await gateway.service.shutdown('test');
  await identity.stop();
});

beforeEach(() => {
  identity.calls.length = 0;
  identity.handlers.clear();
  identity.statuses.set(ACCOUNT, AccountStatus.ACCOUNT_STATUS_PENDING_ONBOARDING);
  refreshCount = 0;
  identity.handlers.set('requestOtp', () => ({
    challengeId: 'c-1',
    expiresAt: new Date(Date.now() + 300_000),
    retryAfterSeconds: 60,
  }));
  identity.handlers.set('verifyOtp', () =>
    identity.session(ACCOUNT, AccountStatus.ACCOUNT_STATUS_PENDING_ONBOARDING, 'refresh-1'),
  );
  identity.handlers.set('refreshSession', async () => {
    refreshCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return identity.session(
      ACCOUNT,
      AccountStatus.ACCOUNT_STATUS_ACTIVE,
      `refresh-${String(refreshCount + 1)}`,
    );
  });
});

async function signIn() {
  const first = await gql(gateway.url, '{ __typename }');
  const requested = await gql(
    gateway.url,
    'mutation ($p: String!) { requestOtp(phone: $p) { challengeId retryAfterSeconds } }',
    { variables: { p: '082 000 0201' }, cookie: jar(first) },
  );
  const verified = await gql(
    gateway.url,
    'mutation { verifyOtp(challengeId: "c-1", code: "123456") { expiresAt account { id status } } }',
    { cookie: jar(first) },
  );
  return { first, requested, verified, cookie: jar(first, verified) };
}

describe('signing in', () => {
  it('passes the number, device and IP to identity and starts a cookie session', async () => {
    const { first, requested, verified } = await signIn();
    expect(requested.body.data?.['requestOtp']).toEqual({
      challengeId: 'c-1',
      retryAfterSeconds: 60,
    });
    const device = named(first, 'chronos_device')?.split(';')[0]?.split('=')[1];
    const request = identity.calls.find((c) => c.method === 'requestOtp')?.request;
    expect(request).toMatchObject({ phoneE164: '082 000 0201', client: { deviceId: device } });
    expect((request?.['client'] as { ip: string }).ip).toMatch(/127\.0\.0\.1/);

    expect(verified.body.data?.['verifyOtp']).toMatchObject({
      account: { id: ACCOUNT, status: 'PENDING_ONBOARDING' },
    });
    for (const name of ['chronos_access', 'chronos_refresh', 'chronos_session']) {
      expect(named(verified, name)).toContain('HttpOnly');
    }
    expect(named(verified, 'chronos_refresh')).toContain('Path=/api/graphql');
    // Tokens never appear in the response body.
    expect(JSON.stringify(verified.body)).not.toMatch(/eyJ|refresh-1/);
  });

  it('uses the new session for the next request', async () => {
    const { cookie } = await signIn();
    const response = await gql(gateway.url, '{ account { id status } }', { cookie });
    expect(response.body.data?.['account']).toEqual({ id: ACCOUNT, status: 'PENDING_ONBOARDING' });
  });

  it('passes identity’s generic messages through, and nothing more', async () => {
    identity.handlers.set('verifyOtp', () => {
      throw new GrpcFailure(status.UNAUTHENTICATED, 'Code not accepted.');
    });
    const response = await gql(
      gateway.url,
      'mutation { verifyOtp(challengeId: "c", code: "1") { expiresAt } }',
    );
    expect(response.body.errors?.[0]).toEqual({
      message: 'Code not accepted.',
      extensions: { code: 'UNAUTHENTICATED' },
    });
    expect(response.setCookies.some((c) => c.startsWith('chronos_access='))).toBe(false);
  });

  it('hides infrastructure errors', async () => {
    identity.handlers.set('requestOtp', () => {
      throw new GrpcFailure(status.UNAVAILABLE, 'connect ECONNREFUSED 10.1.2.3:5432');
    });
    const response = await gql(
      gateway.url,
      'mutation { requestOtp(phone: "0820000202") { challengeId } }',
    );
    expect(response.body.errors?.[0]).toEqual({
      message: 'Service unavailable. Try again.',
      extensions: { code: 'UNAVAILABLE' },
    });
    expect(JSON.stringify(response.body)).not.toContain('10.1.2.3');
  });
});

describe('refreshing (one at a time, ADR-0018)', () => {
  it('exchanges the refresh cookie for new cookies', async () => {
    const { cookie } = await signIn();
    const refreshed = await gql(gateway.url, 'mutation { refreshSession { account { status } } }', {
      cookie,
    });
    expect(refreshed.body.data?.['refreshSession']).toEqual({ account: { status: 'ACTIVE' } });
    expect(named(refreshed, 'chronos_refresh')).toMatch(/^chronos_refresh=refresh-2;/);
    const request = identity.calls.find((c) => c.method === 'refreshSession')?.request;
    expect(request?.['refreshToken']).toBe('refresh-1');
  });

  it('sends parallel refreshes from one browser to identity once, and gives each the new cookies', async () => {
    const { cookie } = await signIn();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        gql(gateway.url, 'mutation { refreshSession { expiresAt } }', { cookie }),
      ),
    );
    expect(refreshCount).toBe(1);
    for (const r of responses)
      expect(named(r, 'chronos_refresh')).toMatch(/^chronos_refresh=refresh-2;/);
  });

  it('asks the client to retry while another replica holds the refresh', async () => {
    const { cookie } = await signIn();
    const lease = await lock.acquire('refresh-1', 5000);
    try {
      const response = await gql(gateway.url, 'mutation { refreshSession { expiresAt } }', {
        cookie,
      });
      expect(codes(response)).toEqual(['REFRESH_IN_PROGRESS']);
      expect(refreshCount).toBe(0);
      expect(response.setCookies.some((c) => c.startsWith('chronos_refresh='))).toBe(false);
    } finally {
      if (lease) await lock.release('refresh-1', lease);
    }
  });

  it('clears the cookies when identity refuses the session', async () => {
    const { cookie } = await signIn();
    identity.handlers.set('refreshSession', () => {
      throw new GrpcFailure(status.UNAUTHENTICATED, 'Session not accepted. Sign in again.');
    });
    const response = await gql(gateway.url, 'mutation { refreshSession { expiresAt } }', {
      cookie,
    });
    expect(codes(response)).toEqual(['UNAUTHENTICATED']);
    expect(named(response, 'chronos_refresh')).toContain('Max-Age=0');
  });

  it('refuses a refresh without a refresh cookie', async () => {
    expect(codes(await gql(gateway.url, 'mutation { refreshSession { expiresAt } }'))).toEqual([
      'UNAUTHENTICATED',
    ]);
  });
});

describe('signing out and onboarding', () => {
  it('signs out of this session and clears the cookies', async () => {
    const { cookie } = await signIn();
    identity.handlers.set('revokeSession', () => ({}));
    const response = await gql(gateway.url, 'mutation { signOut }', { cookie });
    expect(response.body.data).toEqual({ signOut: true });
    expect(identity.calls.find((c) => c.method === 'revokeSession')?.request).toEqual({
      sessionId: `s-${ACCOUNT}`,
      accountId: ACCOUNT,
    });
    for (const name of ['chronos_access', 'chronos_refresh', 'chronos_session'])
      expect(named(response, name)).toContain('Max-Age=0');
  });

  it('records consent with the right type and passes identity’s order rule through', async () => {
    const { cookie } = await signIn();
    identity.handlers.set('recordConsent', () => ({
      account: { accountId: ACCOUNT, status: AccountStatus.ACCOUNT_STATUS_PENDING_ONBOARDING },
    }));
    identity.handlers.set('setDateOfBirth', () => {
      throw new GrpcFailure(
        status.FAILED_PRECONDITION,
        'Accept the terms and the privacy policy first.',
      );
    });
    const consent = await gql(
      gateway.url,
      'mutation { recordConsent(input: { type: HEALTH_PROCESSING, policyVersion: "v", granted: true }) }',
      { cookie },
    );
    expect(consent.body.data).toEqual({ recordConsent: true });
    expect(identity.calls.find((c) => c.method === 'recordConsent')?.request).toMatchObject({
      type: 3,
    });
    const dob = await gql(
      gateway.url,
      'mutation { setDateOfBirth(dateOfBirth: "1990-06-15") { status } }',
      { cookie },
    );
    expect(dob.body.errors?.[0]).toEqual({
      message: 'Accept the terms and the privacy policy first.',
      extensions: { code: 'FAILED_PRECONDITION' },
    });
  });

  it('ends the session on this device when the member is under 18', async () => {
    const { cookie } = await signIn();
    identity.handlers.set('setDateOfBirth', () => ({
      account: { accountId: ACCOUNT, status: AccountStatus.ACCOUNT_STATUS_INELIGIBLE },
    }));
    const response = await gql(
      gateway.url,
      'mutation { setDateOfBirth(dateOfBirth: "2012-01-01") { status } }',
      {
        cookie,
      },
    );
    expect(response.body.data).toEqual({ setDateOfBirth: { status: 'INELIGIBLE' } });
    expect(identity.calls.find((c) => c.method === 'setDateOfBirth')?.request).toMatchObject({
      dateOfBirth: { year: 2012, month: 1, day: 1 },
    });
    expect(named(response, 'chronos_access')).toContain('Max-Age=0');
  });

  it('ends the session on this device when terms are withdrawn', async () => {
    const { cookie } = await signIn();
    identity.handlers.set('recordConsent', () => ({
      account: { accountId: ACCOUNT, status: AccountStatus.ACCOUNT_STATUS_PENDING_ERASURE },
    }));
    const response = await gql(
      gateway.url,
      'mutation { recordConsent(input: { type: TERMS, policyVersion: "v", granted: false }) }',
      { cookie },
    );
    expect(response.body.data).toEqual({ recordConsent: true });
    expect(named(response, 'chronos_refresh')).toContain('Max-Age=0');
  });

  it('rejects a malformed date before calling identity', async () => {
    const { cookie } = await signIn();
    const response = await gql(
      gateway.url,
      'mutation { setDateOfBirth(dateOfBirth: "15/06/1990") { status } }',
      {
        cookie,
      },
    );
    expect(codes(response)).toEqual(['BAD_USER_INPUT']);
    expect(identity.calls.some((c) => c.method === 'setDateOfBirth')).toBe(false);
  });

  it('lists consents and current policies', async () => {
    const { cookie } = await signIn();
    identity.handlers.set('listConsents', () => ({
      records: [
        {
          type: 1,
          policyVersion: 'terms-2026-11-20',
          granted: true,
          recordedAt: new Date('2026-11-20T10:00:00Z'),
        },
      ],
    }));
    identity.handlers.set('getCurrentPolicies', () => ({
      policies: [{ type: 2, version: 'privacy-2026-11-20' }],
    }));
    const response = await gql(
      gateway.url,
      '{ consents { type granted policyVersion } currentPolicies { type version } }',
      {
        cookie,
      },
    );
    expect(response.body.data).toEqual({
      consents: [{ type: 'TERMS', granted: true, policyVersion: 'terms-2026-11-20' }],
      currentPolicies: [{ type: 'PRIVACY', version: 'privacy-2026-11-20' }],
    });
  });
});
