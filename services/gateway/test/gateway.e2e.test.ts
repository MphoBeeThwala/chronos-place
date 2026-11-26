import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountStatus, FakeIdentity } from './support/fake-identity.js';
import { codes, gql, startGateway, type TestGateway } from './support/gateway.js';

const identity = new FakeIdentity();
let gateway: TestGateway;

const PENDING = '11111111-1111-4111-8111-111111111111';
const ACTIVE = '22222222-2222-4222-8222-222222222222';
const INELIGIBLE = '33333333-3333-4333-8333-333333333333';

beforeAll(async () => {
  await identity.start();
  identity.statuses.set(PENDING, AccountStatus.ACCOUNT_STATUS_PENDING_ONBOARDING);
  identity.statuses.set(ACTIVE, AccountStatus.ACCOUNT_STATUS_ACTIVE);
  identity.statuses.set(INELIGIBLE, AccountStatus.ACCOUNT_STATUS_INELIGIBLE);
  gateway = await startGateway(identity);
});

afterAll(async () => {
  await gateway.service.shutdown('test');
  await identity.stop();
});

const signedIn = async (accountId: string) => `chronos_access=${await identity.token(accountId)}`;

describe('sign-in guard (M1.3 AC: unauthenticated access blocked except OTP mutations)', () => {
  it('refuses queries without a session', async () => {
    for (const query of [
      '{ account { id } }',
      '{ me { id } }',
      '{ currentPolicies { version } }',
    ]) {
      const response = await gql(gateway.url, query);
      expect(codes(response)).toEqual(['UNAUTHENTICATED']);
      expect(response.body.data ?? null).toBeNull();
    }
  });

  it('lets the sign-in mutations through without a session', async () => {
    identity.calls.length = 0;
    await gql(gateway.url, 'mutation { requestOtp(phone: "0820000001") { challengeId } }');
    await gql(
      gateway.url,
      'mutation { verifyOtp(challengeId: "c", code: "123456") { expiresAt } }',
    );
    // Past the guard: each reached identity (the fake has no handler, so it fails there).
    expect(identity.calls.map((c) => c.method)).toEqual(['requestOtp', 'verifyOtp']);
  });

  it('refuses a sign-in mutation bundled with anything else', async () => {
    const response = await gql(
      gateway.url,
      'mutation { requestOtp(phone: "0820000001") { challengeId } signOut }',
    );
    expect(codes(response)).toEqual(['UNAUTHENTICATED']);
  });

  it('cannot be bypassed with a fragment', async () => {
    const response = await gql(
      gateway.url,
      `mutation { requestOtp(phone: "0820000001") { challengeId } ...F }
       fragment F on Mutation { deleteAccount(challengeId: "c", code: "123456") { id } }`,
    );
    expect(codes(response)).toEqual(['UNAUTHENTICATED']);
  });

  it('treats a forged, foreign or expired token as no session', async () => {
    const other = new FakeIdentity();
    const foreign = await other.token(ACTIVE);
    const expired = await identity.token(ACTIVE, new Date(Date.now() - 11 * 60_000));
    const valid = await identity.token(ACTIVE);
    const [h, p] = valid.split('.');
    for (const token of [foreign, expired, `${h ?? ''}.${p ?? ''}.AAAA`, 'garbage']) {
      expect(
        codes(await gql(gateway.url, '{ me { id } }', { cookie: `chronos_access=${token}` })),
      ).toEqual(['UNAUTHENTICATED']);
    }
  });

  it('lets an active member reach the rest of the schema', async () => {
    // No discovery runs in this test, so getting past the guard means UNAVAILABLE.
    expect(
      codes(
        await gql(gateway.url, '{ feed { pageInfo { hasNextPage } } }', {
          cookie: await signedIn(ACTIVE),
        }),
      ),
    ).toEqual(['UNAVAILABLE']);
  });

  it('keeps a member who has not finished signing up to the onboarding steps', async () => {
    const cookie = await signedIn(PENDING);
    expect(
      (await gql(gateway.url, '{ account { status } }', { cookie })).body.data?.['account'],
    ).toEqual({ status: 'PENDING_ONBOARDING' });
    for (const query of [
      '{ me { id } }',
      '{ feed { edges { cursor } } }',
      'mutation { like(accountId: "x") { matched } }',
    ]) {
      expect(codes(await gql(gateway.url, query, { cookie }))).toEqual(['FORBIDDEN']);
    }
  });

  it('treats an account that may no longer sign in as signed out', async () => {
    expect(
      codes(await gql(gateway.url, '{ account { id } }', { cookie: await signedIn(INELIGIBLE) })),
    ).toEqual(['UNAUTHENTICATED']);
  });
});

describe('cookies and request hygiene', () => {
  it('gives a new browser a random device id in an httpOnly cookie', async () => {
    const response = await gql(gateway.url, '{ __typename }');
    const device = response.setCookies.find((c) => c.startsWith('chronos_device='));
    expect(device).toMatch(
      /^chronos_device=[A-Za-z0-9_-]{22}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict; Secure$/,
    );
    const again = await gql(gateway.url, '{ __typename }', { cookie: device?.split(';')[0] ?? '' });
    expect(again.setCookies.some((c) => c.startsWith('chronos_device='))).toBe(false);
  });

  it('blocks cross-site form posts (CSRF prevention)', async () => {
    const response = await fetch(gateway.url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ query: 'mutation { signOut }' }),
    });
    expect(response.status).toBe(400);
  });

  it('does not echo literal values from a rejected query', async () => {
    const response = await gql(
      gateway.url,
      'mutation { requestOtp(phone: 820000123) { challengeId } }',
    );
    expect(JSON.stringify(response.body)).not.toContain('820000123');
    expect(codes(response)).toEqual(['GRAPHQL_VALIDATION_FAILED']);
  });

  it('never sends identity the token or the cookie', async () => {
    await gql(gateway.url, '{ account { id } }', { cookie: await signedIn(ACTIVE) });
    for (const call of identity.calls)
      expect(JSON.stringify(call.request)).not.toMatch(/chronos_|eyJ/);
  });
});
