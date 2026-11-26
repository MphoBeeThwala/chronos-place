import { createLogger } from '@chronos/logger';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountStatus, FakeIdentity, GrpcFailure } from './support/fake-identity.js';
import { FakeProfile } from './support/fake-profile.js';
import { codes, gql, startGateway, type TestGateway } from './support/gateway.js';

/** Account deletion through the gateway (TASKS M1.8, ADR-0025). Synthetic data only. */
const identity = new FakeIdentity();
const profile = new FakeProfile();
let gateway: TestGateway;
let n = 0;
const member = (state = AccountStatus.ACCOUNT_STATUS_ACTIVE) => {
  n += 1;
  const id = `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, '0')}`;
  identity.statuses.set(id, state);
  return id;
};
const session = async (id: string) => ({ cookie: `chronos_access=${await identity.token(id)}` });

const REQUEST =
  'mutation { requestAccountDeletionCode { challengeId expiresAt retryAfterSeconds } }';
const DELETE = `mutation D($challengeId: ID!, $code: String!) {
  deleteAccount(challengeId: $challengeId, code: $code) { id status }
}`;
const CHALLENGE = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  await Promise.all([identity.start(), profile.start()]);
  identity.handlers.set('requestDeletionCode', () => ({
    challengeId: CHALLENGE,
    expiresAt: new Date('2026-11-26T10:10:00Z'),
    retryAfterSeconds: 60,
  }));
  identity.handlers.set('deleteAccount', (req) => {
    if (req['code'] !== '123456') {
      throw new GrpcFailure(status.UNAUTHENTICATED, 'Code not accepted.');
    }
    return {
      account: {
        accountId: req['accountId'],
        status: AccountStatus.ACCOUNT_STATUS_PENDING_ERASURE,
      },
    };
  });
  identity.handlers.set('exportAccount', (req) => ({
    account: {
      accountId: req['accountId'],
      status: AccountStatus.ACCOUNT_STATUS_PENDING_ONBOARDING,
    },
    phoneE164: '+27820001111',
    createdAt: new Date('2026-11-26T08:00:00Z'),
  }));
  profile.handlers.set('exportProfile', () => ({ photos: [] }));
  gateway = await startGateway(identity, {
    profile,
    logger: createLogger({ service: 'gateway', destination: { write: () => undefined } }),
  });
});

afterAll(async () => {
  await gateway.service.shutdown('test');
  await Promise.all([identity.stop(), profile.stop()]);
});

describe('account deletion', () => {
  it('asks identity for a code to the signed-in member, with this device', async () => {
    const id = member();
    const res = await gql(gateway.url, REQUEST, await session(id));
    expect(res.body.data?.['requestAccountDeletionCode']).toEqual({
      challengeId: CHALLENGE,
      expiresAt: '2026-11-26T10:10:00.000Z',
      retryAfterSeconds: 60,
    });
    const call = identity.calls.filter((c) => c.method === 'requestDeletionCode').at(-1);
    expect(call?.request['accountId']).toBe(id);
    expect(call?.request['client']).toHaveProperty('ip');
  });

  it('deletes with the right code and signs this device out', async () => {
    const id = member();
    const res = await gql(gateway.url, DELETE, {
      ...(await session(id)),
      variables: { challengeId: CHALLENGE, code: '123456' },
    });
    expect(res.body.data?.['deleteAccount']).toEqual({ id, status: 'PENDING_ERASURE' });
    // Every session cookie is cleared on this device.
    for (const name of ['chronos_access', 'chronos_refresh', 'chronos_session']) {
      const cookie = res.setCookies.find((c) => c.startsWith(`${name}=`));
      expect(cookie, name).toMatch(/Max-Age=0/i);
    }
  });

  it('reports a wrong code as input, not as a lost session, and keeps the member signed in', async () => {
    const id = member();
    const res = await gql(gateway.url, DELETE, {
      ...(await session(id)),
      variables: { challengeId: CHALLENGE, code: '000000' },
    });
    // Not UNAUTHENTICATED: clients would refresh and retry the same wrong code.
    expect(codes(res)).toEqual(['BAD_USER_INPUT']);
    expect(res.body.errors?.[0]?.message).toBe('Code not accepted.');
    expect(res.setCookies.some((c) => /Max-Age=0/i.test(c))).toBe(false);
  });

  it('is open to members who have not finished onboarding, as are their data', async () => {
    const id = member(AccountStatus.ACCOUNT_STATUS_PENDING_ONBOARDING);
    const auth = await session(id);
    expect(codes(await gql(gateway.url, REQUEST, auth))).toEqual([]);
    expect(codes(await gql(gateway.url, '{ myDataExport { format } }', auth))).toEqual([]);
    // Still nothing else beyond the onboarding steps.
    expect(codes(await gql(gateway.url, '{ me { id } }', auth))).toEqual(['FORBIDDEN']);
  });

  it('needs a signed-in member', async () => {
    expect(codes(await gql(gateway.url, REQUEST))).toEqual(['UNAUTHENTICATED']);
  });
});
