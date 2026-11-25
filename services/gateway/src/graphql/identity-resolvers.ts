import { AccountStatus, ConsentType } from '@chronos/contracts/identity';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import { clearSessionCookies, sessionCookies } from '../auth/cookies.js';
import type { GatewayContext } from '../auth/context.js';
import { lockKey, type RefreshLock } from '../auth/refresh-lock.js';
import { fromGrpc } from '../identity/errors.js';
import { type IdentityClient, toDate, type WireTimestamp } from '../identity/identity-client.js';
import type { ResolverMap } from './not-available.js';

/** How long one refresh may hold the lock. Longer than identity's deadline. */
export const REFRESH_LOCK_TTL_MS = 5000;

const INVALID = (): GraphQLError =>
  new GraphQLError('Invalid request.', { extensions: { code: 'BAD_USER_INPUT' } });
const SIGN_IN = (): GraphQLError =>
  new GraphQLError('Sign in to continue.', { extensions: { code: 'UNAUTHENTICATED' } });

// Validated at the edge (CLAUDE.md coding standards).
const args = {
  requestOtp: z.object({ phone: z.string().min(1).max(32) }),
  verifyOtp: z.object({ challengeId: z.string().min(1).max(64), code: z.string().min(1).max(16) }),
  dateOfBirth: z.object({ dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  consent: z.object({
    input: z.object({
      type: z.enum([
        'TERMS',
        'PRIVACY',
        'HEALTH_PROCESSING',
        'MARKETING',
        'BIOMETRIC_VERIFICATION',
      ]),
      policyVersion: z.string().min(1).max(64),
      granted: z.boolean(),
    }),
  }),
};

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw INVALID();
  return result.data;
}

const STATUS: Record<number, string> = {
  [AccountStatus.ACCOUNT_STATUS_PENDING_ONBOARDING]: 'PENDING_ONBOARDING',
  [AccountStatus.ACCOUNT_STATUS_ACTIVE]: 'ACTIVE',
  [AccountStatus.ACCOUNT_STATUS_INELIGIBLE]: 'INELIGIBLE',
  [AccountStatus.ACCOUNT_STATUS_SUSPENDED]: 'SUSPENDED',
  [AccountStatus.ACCOUNT_STATUS_PENDING_ERASURE]: 'PENDING_ERASURE',
};
const CONSENT_TO_WIRE: Record<string, ConsentType> = {
  TERMS: ConsentType.CONSENT_TYPE_TERMS,
  PRIVACY: ConsentType.CONSENT_TYPE_PRIVACY,
  HEALTH_PROCESSING: ConsentType.CONSENT_TYPE_HEALTH_PROCESSING,
  MARKETING: ConsentType.CONSENT_TYPE_MARKETING,
  BIOMETRIC_VERIFICATION: ConsentType.CONSENT_TYPE_BIOMETRIC_VERIFICATION,
};
const CONSENT_FROM_WIRE = new Map<number, string>(
  Object.entries(CONSENT_TO_WIRE).map(([name, value]) => [value, name]),
);

interface WireAccount {
  accountId: string;
  status: AccountStatus;
}
interface WireTokens {
  accessToken: string;
  accessExpiresAt: Date | WireTimestamp;
  refreshToken: string;
  refreshExpiresAt: Date | WireTimestamp;
}
interface SessionResult {
  account: WireAccount;
  tokens: WireTokens;
}

const account = (a: WireAccount) => ({ id: a.accountId, status: STATUS[a.status] ?? 'SUSPENDED' });
const usable = (status: AccountStatus) =>
  status === AccountStatus.ACCOUNT_STATUS_ACTIVE ||
  status === AccountStatus.ACCOUNT_STATUS_PENDING_ONBOARDING;

const viewerOf = (ctx: GatewayContext) => {
  if (!ctx.viewer) throw SIGN_IN();
  return ctx.viewer;
};

export interface IdentityResolverDeps {
  identity: IdentityClient;
  refreshLock: RefreshLock;
  forgetAccountState: (accountId: string) => void;
}

/** Sign-in, session, onboarding and consent fields, served by the identity service. */
export function identityResolvers(deps: IdentityResolverDeps): ResolverMap {
  const call = async <T>(method: string, request: object): Promise<T> => {
    try {
      return await deps.identity.call<T>(method, request);
    } catch (error) {
      throw fromGrpc(error);
    }
  };

  const startSession = (ctx: GatewayContext, result: SessionResult) => {
    const tokens = {
      accessToken: result.tokens.accessToken,
      accessExpiresAt: toDate(result.tokens.accessExpiresAt),
      refreshToken: result.tokens.refreshToken,
      refreshExpiresAt: toDate(result.tokens.refreshExpiresAt),
    };
    ctx.setCookies.push(...sessionCookies(tokens, ctx.cookieOptions));
    return { expiresAt: tokens.accessExpiresAt.toISOString(), account: account(result.account) };
  };

  const endSession = (ctx: GatewayContext) => {
    ctx.setCookies.push(...clearSessionCookies(ctx.cookieOptions));
  };

  // Concurrent refreshes in this process share one exchange, and both responses carry the new
  // cookies. Across replicas the Redis lock stops a second exchange from reaching identity.
  const inflight = new Map<string, Promise<SessionResult>>();

  const refresh = async (
    refreshToken: string,
    client: { deviceId: string; ip: string },
  ): Promise<SessionResult> => {
    const lease = await deps.refreshLock.acquire(refreshToken, REFRESH_LOCK_TTL_MS);
    if (lease === undefined) {
      throw new GraphQLError('A refresh is already in progress. Retry shortly.', {
        extensions: { code: 'REFRESH_IN_PROGRESS' },
      });
    }
    try {
      return await call<SessionResult>('refreshSession', { refreshToken, client });
    } finally {
      await deps.refreshLock.release(refreshToken, lease);
    }
  };

  return {
    Query: {
      account: async (_parent, _args, ctx) => {
        const viewer = viewerOf(ctx as GatewayContext);
        const result = await call<{ account: WireAccount }>('getAccount', {
          accountId: viewer.accountId,
        });
        return account(result.account);
      },
      consents: async (_parent, _args, ctx) => {
        const viewer = viewerOf(ctx as GatewayContext);
        const result = await call<{
          records: {
            type: number;
            policyVersion: string;
            granted: boolean;
            recordedAt: Date | WireTimestamp;
          }[];
        }>('listConsents', { accountId: viewer.accountId });
        return result.records.map((r) => ({
          type: CONSENT_FROM_WIRE.get(r.type),
          policyVersion: r.policyVersion,
          granted: r.granted,
          recordedAt: toDate(r.recordedAt).toISOString(),
        }));
      },
      currentPolicies: async () => {
        const result = await call<{ policies: { type: number; version: string }[] }>(
          'getCurrentPolicies',
          {},
        );
        return result.policies.map((p) => ({
          type: CONSENT_FROM_WIRE.get(p.type),
          version: p.version,
        }));
      },
    },
    Mutation: {
      requestOtp: async (_parent, raw, ctx) => {
        const { phone } = parse(args.requestOtp, raw);
        const c = ctx as GatewayContext;
        const result = await call<{
          challengeId: string;
          expiresAt: Date | WireTimestamp;
          retryAfterSeconds: number;
        }>('requestOtp', { phoneE164: phone, client: { deviceId: c.deviceId, ip: c.ip } });
        return {
          challengeId: result.challengeId,
          expiresAt: toDate(result.expiresAt).toISOString(),
          retryAfterSeconds: result.retryAfterSeconds,
        };
      },
      verifyOtp: async (_parent, raw, ctx) => {
        const { challengeId, code } = parse(args.verifyOtp, raw);
        const c = ctx as GatewayContext;
        const result = await call<SessionResult>('verifyOtp', {
          challengeId,
          code,
          client: { deviceId: c.deviceId, ip: c.ip },
        });
        return startSession(c, result);
      },
      refreshSession: async (_parent, _args, ctx) => {
        const c = ctx as GatewayContext;
        if (c.refreshToken === undefined) throw SIGN_IN();
        const key = lockKey(c.refreshToken);
        let pending = inflight.get(key);
        if (!pending) {
          pending = refresh(c.refreshToken, { deviceId: c.deviceId, ip: c.ip }).finally(() =>
            inflight.delete(key),
          );
          inflight.set(key, pending);
        }
        try {
          return startSession(c, await pending);
        } catch (error) {
          if ((error as GraphQLError).extensions['code'] === 'UNAUTHENTICATED') endSession(c);
          throw error;
        }
      },
      signOut: async (_parent, _args, ctx) => {
        const c = ctx as GatewayContext;
        const viewer = viewerOf(c);
        await call('revokeSession', { sessionId: viewer.sessionId, accountId: viewer.accountId });
        deps.forgetAccountState(viewer.accountId);
        endSession(c);
        return true;
      },
      setDateOfBirth: async (_parent, raw, ctx) => {
        const c = ctx as GatewayContext;
        const viewer = viewerOf(c);
        const { dateOfBirth } = parse(args.dateOfBirth, raw);
        const [year, month, day] = dateOfBirth.split('-').map(Number);
        const result = await call<{ account: WireAccount }>('setDateOfBirth', {
          accountId: viewer.accountId,
          dateOfBirth: { year, month, day },
        });
        deps.forgetAccountState(viewer.accountId);
        // Under 18: identity has ended every session; clear this device's cookies too.
        if (!usable(result.account.status)) endSession(c);
        return account(result.account);
      },
      recordConsent: async (_parent, raw, ctx) => {
        const c = ctx as GatewayContext;
        const viewer = viewerOf(c);
        const { input } = parse(args.consent, raw);
        const result = await call<{ account: WireAccount }>('recordConsent', {
          accountId: viewer.accountId,
          type: CONSENT_TO_WIRE[input.type],
          policyVersion: input.policyVersion,
          granted: input.granted,
        });
        deps.forgetAccountState(viewer.accountId);
        // Withdrawing terms or privacy starts account deletion and ends every session (ADR-0020).
        if (!usable(result.account.status)) endSession(c);
        return true;
      },
    },
  };
}
