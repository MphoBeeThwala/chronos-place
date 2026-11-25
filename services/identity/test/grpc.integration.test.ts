import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { AccountStatus, ConsentType, VerificationStatus } from '@chronos/contracts/identity';
import { SubjectKeyring } from '@chronos/crypto';
import { InMemoryKeyWrapper } from '@chronos/crypto/testing';
import { bootstrapService, type RunningService } from '@chronos/service-kit';
import { status } from '@grpc/grpc-js';
import { ClientProxyFactory, Transport, type ClientGrpc } from '@nestjs/microservices';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { firstValueFrom, type Observable } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppModule } from '../src/app.module.js';
import { identityConfig } from '../src/config.js';
import { DrizzleAccountKeyStore } from '../src/crypto/account-key-store.js';
import { runMigrations } from '../src/db/migrate.js';
import { IDENTITY_KEY_PURPOSE } from '../src/otp/otp.service.js';
import { IDENTITY_PACKAGE, IDENTITY_PROTO } from '../src/proto.js';
import { LocalAccessTokenSigner } from '../src/sessions/access-token.js';
import { FakeLivenessProvider } from '../src/verification/provider.js';
import { startTestDatabase, type TestDatabase } from './support/database.js';
import { RecordingOtpSender } from './support/otp-fakes.js';
import { startTestRedis, type TestRedis } from './support/redis.js';

type Call<Req, Res> = (request: Req) => Observable<Res>;
interface Tokens {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}
interface Account {
  accountId: string;
  status: number;
  verified: boolean;
}
interface Verification {
  status: VerificationStatus;
  attemptsRemaining: number;
  reviewAvailable: boolean;
}
interface Client {
  deviceId: string;
  ip: string;
}
interface IdentityClient {
  requestOtp: Call<
    { phoneE164: string; client: Client },
    { challengeId: string; retryAfterSeconds: number }
  >;
  verifyOtp: Call<
    { challengeId: string; code: string; client: Client },
    { account: Account; tokens: Tokens; created: boolean }
  >;
  refreshSession: Call<
    { refreshToken: string; client: Client },
    { account: Account; tokens: Tokens }
  >;
  revokeSession: Call<{ sessionId: string; accountId: string }, object>;
  revokeAllSessions: Call<{ accountId: string }, object>;
  setDateOfBirth: Call<
    { accountId: string; dateOfBirth: { year: number; month: number; day: number } },
    { account: Account }
  >;
  getAccount: Call<{ accountId: string }, { account: Account }>;
  getSigningKeys: Call<object, { keys: { kid: string; jwkJson: string }[] }>;
  recordConsent: Call<
    { accountId: string; type: ConsentType; policyVersion: string; granted: boolean },
    { account: Account }
  >;
  listConsents: Call<
    { accountId: string },
    { records?: { type: ConsentType; policyVersion: string; granted: boolean; recordedAt: Date }[] }
  >;
  getCurrentPolicies: Call<object, { policies: { type: ConsentType; version: string }[] }>;
  submitLiveness: Call<
    {
      accountId: string;
      capture: { selfieJpeg: Buffer; livenessFramesJpeg: Buffer[] };
    },
    { verification: Verification }
  >;
  getVerification: Call<{ accountId: string }, { verification: Verification }>;
  getMemberFacts: Call<
    { accountIds: string[] },
    { members?: { accountId: string; age: number; verified: boolean }[] }
  >;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });

let db: TestDatabase;
let redis: TestRedis;
let service: RunningService;
let identity: IdentityClient;
let closeClient: () => void;
let keyPool: pg.Pool;
const sender = new RecordingOtpSender();
const liveness = new FakeLivenessProvider();
const CLIENT = { deviceId: 'device-e2e', ip: '192.0.2.10' };

beforeAll(async () => {
  [db, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
  await runMigrations(db.url);
  await redis.redis.flushdb();
  keyPool = new pg.Pool({ connectionString: db.url });
  const grpcPort = await freePort();
  const redisUrl = `redis://${redis.redis.options.host ?? '127.0.0.1'}:${String(redis.redis.options.port ?? 6379)}`;
  service = await bootstrapService({
    module: createAppModule({
      sender,
      livenessProvider: liveness,
      signer: new LocalAccessTokenSigner(),
      keyring: new SubjectKeyring({
        wrapper: new InMemoryKeyWrapper(),
        store: new DrizzleAccountKeyStore(drizzle(keyPool)),
        purpose: IDENTITY_KEY_PURPOSE,
        cacheTtlMs: 0,
      }),
    }),
    extraConfig: identityConfig,
    grpc: { packageName: IDENTITY_PACKAGE, protoPath: IDENTITY_PROTO },
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'identity',
      HTTP_PORT: String(await freePort()),
      GRPC_PORT: String(grpcPort),
      SHUTDOWN_DRAIN_MS: '0',
      DATABASE_URL: db.url,
      REDIS_URL: redisUrl,
      IDENTITY_DATA_KEY_ID: 'unused-in-test',
      PHONE_LOOKUP_KEY: randomBytes(32).toString('base64'),
      OTP_CODE_KEY: randomBytes(32).toString('base64'),
    },
    onInvalidConfig: 'throw',
    installSignalHandlers: false,
    exit: () => undefined,
  });
  const proxy = ClientProxyFactory.create({
    transport: Transport.GRPC,
    options: {
      package: IDENTITY_PACKAGE,
      protoPath: IDENTITY_PROTO,
      url: `127.0.0.1:${String(grpcPort)}`,
    },
  }) as unknown as ClientGrpc & { close: () => void };
  identity = proxy.getService<IdentityClient>('IdentityService');
  closeClient = () => {
    proxy.close();
  };
});

afterAll(async () => {
  closeClient();
  await service.shutdown('test');
  await keyPool.end();
  await Promise.all([db.stop(), redis.stop()]);
});

const call = firstValueFrom;

async function grpcError(promise: Promise<unknown>): Promise<{ code: number; details: string }> {
  const error = (await promise.then(
    () => undefined,
    (e: unknown) => e,
  )) as { code?: number; details?: string } | undefined;
  expect(error?.code).toBeTypeOf('number');
  return { code: error?.code ?? -1, details: error?.details ?? '' };
}

async function signIn(phone: string) {
  const { challengeId } = await call(identity.requestOtp({ phoneE164: phone, client: CLIENT }));
  return call(identity.verifyOtp({ challengeId, code: sender.lastCode(), client: CLIENT }));
}

/** Accepts the current terms and privacy policy, as onboarding requires before the date of birth. */
async function acceptRequired(accountId: string) {
  const { policies } = await call(identity.getCurrentPolicies({}));
  for (const type of [ConsentType.CONSENT_TYPE_TERMS, ConsentType.CONSENT_TYPE_PRIVACY]) {
    const version = policies.find((p) => p.type === type)?.version ?? '';
    await call(identity.recordConsent({ accountId, type, policyVersion: version, granted: true }));
  }
}

const sid = (accessToken: string) =>
  (
    JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString()) as {
      sid: string;
    }
  ).sid;

describe('identity gRPC API', () => {
  it('signs in a new member, takes an adult date of birth and refreshes the session', async () => {
    const first = await signIn('082 000 0101');
    expect(first.created).toBe(true);
    expect(first.account.status).toBe(AccountStatus.ACCOUNT_STATUS_PENDING_ONBOARDING);
    expect(new Date(first.tokens.accessExpiresAt).getTime()).toBeGreaterThan(Date.now());

    await acceptRequired(first.account.accountId);
    const { account } = await call(
      identity.setDateOfBirth({
        accountId: first.account.accountId,
        dateOfBirth: { year: 1990, month: 6, day: 15 },
      }),
    );
    expect(account.status).toBe(AccountStatus.ACCOUNT_STATUS_ACTIVE);

    const refreshed = await call(
      identity.refreshSession({ refreshToken: first.tokens.refreshToken, client: CLIENT }),
    );
    expect(refreshed.account.status).toBe(AccountStatus.ACCOUNT_STATUS_ACTIVE);
    const reused = await grpcError(
      call(identity.refreshSession({ refreshToken: first.tokens.refreshToken, client: CLIENT })),
    );
    expect(reused.code).toBe(status.UNAUTHENTICATED);
  });

  it('blocks an under-18 member for good', async () => {
    const first = await signIn('082 000 0102');
    const year = new Date().getUTCFullYear() - 16;
    await acceptRequired(first.account.accountId);
    const { account } = await call(
      identity.setDateOfBirth({
        accountId: first.account.accountId,
        dateOfBirth: { year, month: 1, day: 1 },
      }),
    );
    expect(account.status).toBe(AccountStatus.ACCOUNT_STATUS_INELIGIBLE);
    expect(
      (
        await grpcError(
          call(
            identity.refreshSession({ refreshToken: first.tokens.refreshToken, client: CLIENT }),
          ),
        )
      ).code,
    ).toBe(status.UNAUTHENTICATED);
    // Skip the 60-second resend cooldown so the second sign-in reaches the account check.
    for (const key of await redis.redis.keys('identity:otp:v1:cooldown:*'))
      await redis.redis.del(key);
    expect((await grpcError(signIn('082 000 0102'))).code).toBe(status.FAILED_PRECONDITION);
  });

  it('signs out', async () => {
    const first = await signIn('082 000 0103');
    await call(
      identity.revokeSession({
        sessionId: sid(first.tokens.accessToken),
        accountId: first.account.accountId,
      }),
    );
    expect(
      (
        await grpcError(
          call(
            identity.refreshSession({ refreshToken: first.tokens.refreshToken, client: CLIENT }),
          ),
        )
      ).code,
    ).toBe(status.UNAUTHENTICATED);
  });

  it('rejects numbers outside South Africa and malformed requests with fixed messages', async () => {
    const abroad = await grpcError(
      call(identity.requestOtp({ phoneE164: '+26771234567', client: CLIENT })),
    );
    expect(abroad).toEqual({
      code: status.INVALID_ARGUMENT,
      details: 'Enter a South African mobile number.',
    });
    const malformed = await grpcError(call(identity.getAccount({ accountId: 'not-a-uuid' })));
    expect(malformed).toEqual({ code: status.INVALID_ARGUMENT, details: 'Invalid request.' });
  });

  it('answers a wrong code with UNAUTHENTICATED and nothing more', async () => {
    const { challengeId } = await call(
      identity.requestOtp({ phoneE164: '0820000104', client: CLIENT }),
    );
    const wrong = sender.lastCode() === '000000' ? '000001' : '000000';
    expect(
      await grpcError(call(identity.verifyOtp({ challengeId, code: wrong, client: CLIENT }))),
    ).toEqual({ code: status.UNAUTHENTICATED, details: 'Code not accepted.' });
  });

  it('publishes the public signing key for the gateway', async () => {
    const { keys } = await call(identity.getSigningKeys({}));
    expect(keys).toHaveLength(1);
    const jwk = JSON.parse(keys[0]?.jwkJson ?? '{}') as Record<string, unknown>;
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(jwk).not.toHaveProperty('d');
  });

  it('takes the date of birth only after terms and privacy are accepted', async () => {
    const first = await signIn('082 000 0105');
    const refused = await grpcError(
      call(
        identity.setDateOfBirth({
          accountId: first.account.accountId,
          dateOfBirth: { year: 1990, month: 1, day: 1 },
        }),
      ),
    );
    expect(refused).toEqual({
      code: status.FAILED_PRECONDITION,
      details: 'Accept the terms and the privacy policy first.',
    });
    await acceptRequired(first.account.accountId);
    const { records } = await call(identity.listConsents({ accountId: first.account.accountId }));
    expect(records?.map((r) => [r.type, r.granted])).toEqual([
      [ConsentType.CONSENT_TYPE_TERMS, true],
      [ConsentType.CONSENT_TYPE_PRIVACY, true],
    ]);
  });

  it('refuses an outdated policy version, and ends the account when terms are withdrawn', async () => {
    const first = await signIn('082 000 0106');
    const outdated = await grpcError(
      call(
        identity.recordConsent({
          accountId: first.account.accountId,
          type: ConsentType.CONSENT_TYPE_TERMS,
          policyVersion: 'terms-2020-01-01',
          granted: true,
        }),
      ),
    );
    expect(outdated.code).toBe(status.FAILED_PRECONDITION);
    const { policies } = await call(identity.getCurrentPolicies({}));
    const terms = policies.find((p) => p.type === ConsentType.CONSENT_TYPE_TERMS)?.version ?? '';
    const { account } = await call(
      identity.recordConsent({
        accountId: first.account.accountId,
        type: ConsentType.CONSENT_TYPE_TERMS,
        policyVersion: terms,
        granted: false,
      }),
    );
    expect(account.status).toBe(AccountStatus.ACCOUNT_STATUS_PENDING_ERASURE);
    expect(
      (
        await grpcError(
          call(
            identity.refreshSession({ refreshToken: first.tokens.refreshToken, client: CLIENT }),
          ),
        )
      ).code,
    ).toBe(status.UNAUTHENTICATED);
  });

  it('takes a liveness capture over the wire once the member has agreed to the check', async () => {
    const first = await signIn('082 000 0107');
    const accountId = first.account.accountId;
    await acceptRequired(accountId);
    await call(
      identity.setDateOfBirth({ accountId, dateOfBirth: { year: 1990, month: 1, day: 1 } }),
    );
    const jpeg = (tag: string) =>
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1_000, tag)]);
    const capture = { selfieJpeg: jpeg('S'), livenessFramesJpeg: [jpeg('A'), jpeg('B')] };

    const refused = await grpcError(call(identity.submitLiveness({ accountId, capture })));
    expect(refused).toEqual({
      code: status.FAILED_PRECONDITION,
      details: 'Agree to the selfie check before starting it.',
    });

    const { policies } = await call(identity.getCurrentPolicies({}));
    const type = ConsentType.CONSENT_TYPE_BIOMETRIC_VERIFICATION;
    const version = policies.find((p) => p.type === type)?.version ?? '';
    await call(identity.recordConsent({ accountId, type, policyVersion: version, granted: true }));

    const { verification } = await call(identity.submitLiveness({ accountId, capture }));
    expect(verification.status).toBe(VerificationStatus.VERIFICATION_STATUS_PENDING);
    expect(verification.attemptsRemaining).toBe(4);
    const sent = liveness.submitted.at(-1);
    expect(sent?.capture.selfie.equals(capture.selfieJpeg)).toBe(true);
    expect(sent?.capture.frames).toHaveLength(2);
    expect(sent?.reference).not.toBe(accountId);

    const { account } = await call(identity.getAccount({ accountId }));
    expect(account.verified).toBe(false);
    expect((await call(identity.getVerification({ accountId }))).verification.status).toBe(
      VerificationStatus.VERIFICATION_STATUS_PENDING,
    );
  });

  it('gives other services a whole-year age for active members only', async () => {
    const adult = await signIn('082 000 0108');
    await acceptRequired(adult.account.accountId);
    await call(
      identity.setDateOfBirth({
        accountId: adult.account.accountId,
        dateOfBirth: { year: 1990, month: 1, day: 1 },
      }),
    );
    const onboarding = await signIn('082 000 0109');
    const { members } = await call(
      identity.getMemberFacts({
        accountIds: [adult.account.accountId, onboarding.account.accountId],
      }),
    );
    expect(members).toHaveLength(1);
    expect(members?.[0]).toMatchObject({ accountId: adult.account.accountId, verified: false });
    expect(members?.[0]?.age).toBeGreaterThanOrEqual(36);
    const tooMany = Array.from({ length: 101 }, () => adult.account.accountId);
    expect((await grpcError(call(identity.getMemberFacts({ accountIds: tooMany })))).code).toBe(
      status.INVALID_ARGUMENT,
    );
  });
});
