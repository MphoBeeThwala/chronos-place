import { VerificationFailure, VerificationStatus } from '@chronos/contracts/identity';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { identityResolvers } from '../src/graphql/identity-resolvers.js';
import { CAPTURE_PATH } from '../src/verification/capture-route.js';
import { AccountStatus, FakeIdentity, GrpcFailure } from './support/fake-identity.js';
import { codes, gql, startGateway, type TestGateway } from './support/gateway.js';

const MEMBER = '33333333-3333-4333-8333-333333333333';
const identity = new FakeIdentity();
let gateway: TestGateway;
let captureUrl: string;

/** Synthetic JPEG bytes: magic number and filler, never a real face. */
const jpeg = (tag: string, size = 1_000) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, tag)]);
const b64 = (b: Buffer) => b.toString('base64');

const pending = {
  verification: {
    status: VerificationStatus.VERIFICATION_STATUS_PENDING,
    failure: VerificationFailure.VERIFICATION_FAILURE_UNSPECIFIED,
    attemptsRemaining: 4,
    reviewAvailable: false,
  },
};

beforeAll(async () => {
  await identity.start();
  gateway = await startGateway(identity, {
    // `me` stands in for the messaging fields that join VERIFIED_FIELDS in M4.
    verifiedFields: ['me'],
    resolvers: (runtime) => {
      const served = identityResolvers(runtime);
      return { ...served, Query: { ...served['Query'], me: () => ({ id: MEMBER }) } };
    },
  });
  captureUrl = gateway.url.replace('/graphql', CAPTURE_PATH);
});

afterAll(async () => {
  await gateway.service.shutdown('test');
  await identity.stop();
});

beforeEach(() => {
  identity.handlers.clear();
  identity.calls.length = 0;
  identity.statuses.set(MEMBER, AccountStatus.ACCOUNT_STATUS_ACTIVE);
  identity.verified.delete(MEMBER);
});

async function post(body: unknown, options: { cookie?: string; type?: string } = {}) {
  const response = await fetch(captureUrl, {
    method: 'POST',
    headers: {
      'content-type': options.type ?? 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: (text ? JSON.parse(text) : {}) as {
      status?: string;
      error?: { code: string; message: string };
    },
  };
}

const session = async (accountId = MEMBER) => `chronos_access=${await identity.token(accountId)}`;
const capture = () => ({
  selfie: `data:image/jpeg;base64,${b64(jpeg('S'))}`,
  frames: [b64(jpeg('A')), b64(jpeg('B'))],
});

describe('capture upload (ADR-0022 decision 4)', () => {
  it('passes the decoded images to identity for the signed-in member', async () => {
    identity.handlers.set('submitLiveness', () => pending);
    const response = await post(capture(), { cookie: await session() });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'PENDING',
      failure: null,
      attemptsRemaining: 4,
      reviewAvailable: false,
    });
    expect(response.headers.get('cache-control')).toBe('no-store');

    const call = identity.calls.find((c) => c.method === 'submitLiveness');
    const sent = call?.request as {
      accountId: string;
      capture: { selfieJpeg: Buffer; livenessFramesJpeg: Buffer[] };
    };
    expect(sent.accountId).toBe(MEMBER);
    expect(Buffer.from(sent.capture.selfieJpeg).equals(jpeg('S'))).toBe(true);
    expect(sent.capture.livenessFramesJpeg).toHaveLength(2);
  });

  it('needs a session and a finished sign-up', async () => {
    // Fresh ids: the gateway caches account state for 15 seconds.
    const onboarding = '33333333-3333-4333-8333-333333333341';
    const suspended = '33333333-3333-4333-8333-333333333342';
    identity.statuses.set(onboarding, AccountStatus.ACCOUNT_STATUS_PENDING_ONBOARDING);
    identity.statuses.set(suspended, AccountStatus.ACCOUNT_STATUS_SUSPENDED);
    expect((await post(capture())).status).toBe(401);
    expect((await post(capture(), { cookie: await session(onboarding) })).status).toBe(403);
    expect((await post(capture(), { cookie: await session(suspended) })).status).toBe(401);
    expect(identity.calls.some((c) => c.method === 'submitLiveness')).toBe(false);
  });

  it('rejects malformed, oversized and non-JSON uploads before calling identity', async () => {
    const cookie = await session();
    expect((await post({ selfie: b64(jpeg('S')), frames: [] }, { cookie })).status).toBe(400);
    expect((await post({ selfie: 'not base64!', frames: ['AA=='] }, { cookie })).status).toBe(400);
    const big = b64(jpeg('X', 1024 * 1024));
    expect((await post({ selfie: big, frames: [big, big, big] }, { cookie })).status).toBe(413);
    expect(
      (await post('selfie=x', { cookie, type: 'application/x-www-form-urlencoded' })).status,
    ).toBe(415);
    expect(identity.calls.some((c) => c.method === 'submitLiveness')).toBe(false);
  });

  it("passes identity's fixed messages through with a matching HTTP status", async () => {
    const cookie = await session();
    identity.handlers.set('submitLiveness', () => {
      throw new GrpcFailure(
        status.FAILED_PRECONDITION,
        'Agree to the selfie check before starting it.',
      );
    });
    expect(await post(capture(), { cookie })).toMatchObject({
      status: 409,
      body: {
        error: {
          code: 'FAILED_PRECONDITION',
          message: 'Agree to the selfie check before starting it.',
        },
      },
    });
    identity.handlers.set('submitLiveness', () => {
      throw new GrpcFailure(status.RESOURCE_EXHAUSTED, 'You have used all your attempts for now.');
    });
    expect((await post(capture(), { cookie })).status).toBe(429);
    identity.handlers.set('submitLiveness', () => {
      throw new GrpcFailure(status.INTERNAL, 'stack trace with internals');
    });
    expect(await post(capture(), { cookie })).toMatchObject({
      status: 500,
      body: { error: { code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong.' } },
    });
  });
});

describe('verification over GraphQL', () => {
  it('reports the state and the verified flag', async () => {
    const cookie = await session();
    identity.handlers.set('getVerification', () => ({
      verification: {
        status: VerificationStatus.VERIFICATION_STATUS_FAILED,
        failure: VerificationFailure.VERIFICATION_FAILURE_POOR_QUALITY,
        attemptsRemaining: 2,
        reviewAvailable: true,
      },
    }));
    const result = await gql(
      gateway.url,
      '{ verification { status failure attemptsRemaining reviewAvailable } account { verified } }',
      { cookie },
    );
    expect(result.body.data).toEqual({
      verification: {
        status: 'FAILED',
        failure: 'POOR_QUALITY',
        attemptsRemaining: 2,
        reviewAvailable: true,
      },
      account: { verified: false },
    });
  });

  it('asks for a review', async () => {
    identity.handlers.set('requestVerificationReview', () => ({
      verification: {
        ...pending.verification,
        status: VerificationStatus.VERIFICATION_STATUS_IN_REVIEW,
      },
    }));
    const result = await gql(gateway.url, 'mutation { requestVerificationReview { status } }', {
      cookie: await session(),
    });
    expect(result.body.data).toEqual({ requestVerificationReview: { status: 'IN_REVIEW' } });
  });
});

describe('the verified gate (M1.4 AC: messaging blocked until verified)', () => {
  it('refuses gated fields until the selfie check has passed', async () => {
    const other = '33333333-3333-4333-8333-333333333335';
    identity.statuses.set(other, AccountStatus.ACCOUNT_STATUS_ACTIVE);
    const refused = await gql(gateway.url, '{ me { id } }', { cookie: await session(other) });
    expect(refused.status).toBe(403);
    expect(codes(refused)).toEqual(['VERIFICATION_REQUIRED']);

    const verified = '33333333-3333-4333-8333-333333333336';
    identity.statuses.set(verified, AccountStatus.ACCOUNT_STATUS_ACTIVE);
    identity.verified.add(verified);
    const allowed = await gql(gateway.url, '{ me { id } }', { cookie: await session(verified) });
    expect(allowed.body.errors).toBeUndefined();
  });

  it('does not gate the verification fields themselves', async () => {
    identity.handlers.set('getVerification', () => pending);
    const result = await gql(gateway.url, '{ verification { status } }', {
      cookie: await session(),
    });
    expect(result.body.data).toEqual({ verification: { status: 'PENDING' } });
  });
});
