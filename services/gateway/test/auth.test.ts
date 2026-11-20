import { generateKeyPairSync } from 'node:crypto';
import { thumbprint } from '@chronos/session-tokens';
import { parse, type OperationDefinitionNode } from 'graphql';
import { describe, expect, it } from 'vitest';
import { clientIp } from '../src/auth/context.js';
import {
  clearSessionCookies,
  deviceCookie,
  parseCookies,
  sessionCookies,
} from '../src/auth/cookies.js';
import { rootFields } from '../src/auth/guard.js';
import { REFETCH_INTERVAL_MS, SigningKeyCache } from '../src/auth/signing-keys.js';
import { formatError } from '../src/graphql/errors.js';

const options = { secure: true, graphqlPath: '/api/graphql' };
const NOW = new Date('2026-11-21T10:00:00Z');

describe('cookies (ADR-0017: tokens never reach browser JavaScript)', () => {
  it('are httpOnly, Secure and SameSite=Strict, with the refresh token scoped to GraphQL', () => {
    const [access, refresh, marker] = sessionCookies(
      {
        accessToken: 'a.b.c',
        accessExpiresAt: new Date(NOW.getTime() + 600_000),
        refreshToken: 'r',
        refreshExpiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
      },
      options,
      NOW,
    );
    for (const cookie of [access, refresh, marker]) {
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Secure');
    }
    expect(access).toMatch(/^chronos_access=a\.b\.c; Path=\/; Max-Age=600;/);
    expect(refresh).toMatch(/^chronos_refresh=r; Path=\/api\/graphql; Max-Age=2592000;/);
    expect(marker).toMatch(/^chronos_session=1; Path=\/;/);
  });

  it('are cleared with Max-Age=0 on sign-out', () => {
    for (const cookie of clearSessionCookies(options)) expect(cookie).toContain('Max-Age=0');
  });

  it('omit Secure only when told to (local HTTP development)', () => {
    expect(deviceCookie('d', { ...options, secure: false })).not.toContain('Secure');
  });

  it('parse the first value of each name and skip malformed entries', () => {
    const cookies = parseCookies('a=1; b=%E0%A4%A; a=2; =x; c=hello%20world');
    expect(cookies.get('a')).toBe('1');
    expect(cookies.has('b')).toBe(false);
    expect(cookies.get('c')).toBe('hello world');
  });
});

describe('client IP', () => {
  const req = (xff?: string) => ({
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    socket: { remoteAddress: '10.0.0.9' },
  });

  it('takes the entry just before the trusted proxies', () => {
    expect(clientIp(req('203.0.113.7, 10.0.0.2'), 1)).toBe('10.0.0.2');
    expect(clientIp(req('203.0.113.7, 10.0.0.2'), 2)).toBe('203.0.113.7');
  });

  it('ignores X-Forwarded-For when no proxy is trusted, so clients cannot forge their IP', () => {
    expect(clientIp(req('1.2.3.4'), 0)).toBe('10.0.0.9');
  });

  it('falls back to the socket when the header is missing', () => {
    expect(clientIp(req(), 1)).toBe('10.0.0.9');
  });
});

describe('signing key cache', () => {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
    format: 'jwk',
  });
  const kid = thumbprint(jwk);

  it('fetches on an unknown kid, at most once per interval', async () => {
    let fetches = 0;
    let now = 0;
    const cache = new SigningKeyCache(
      {
        fetch: () => {
          fetches += 1;
          return Promise.resolve([{ kid, jwkJson: JSON.stringify(jwk) }]);
        },
      },
      () => now,
    );
    expect(await cache.resolve(kid)).toBeDefined();
    await cache.resolve('forged-1');
    await cache.resolve('forged-2');
    expect(fetches).toBe(1);
    now += REFETCH_INTERVAL_MS;
    await cache.resolve('forged-3');
    expect(fetches).toBe(2);
  });
});

describe('guard: root fields', () => {
  const fields = (source: string) => {
    const document = parse(source);
    return rootFields(document.definitions[0] as OperationDefinitionNode, document);
  };

  it('follows fragments and inline fragments, so they cannot hide a field', () => {
    expect(
      fields(`mutation { requestOtp(phone: "x") { challengeId } ...F ... on Mutation { signOut } }
              fragment F on Mutation { like(accountId: "1") { matched } }`),
    ).toEqual(['requestOtp', 'like', 'signOut']);
  });

  it('ignores __typename', () => {
    expect(fields('{ __typename }')).toEqual([]);
  });
});

describe('error masking (CLAUDE.md rule 3)', () => {
  it('drops the text of parse and validation errors, which can quote literal values', () => {
    expect(
      formatError({
        message: 'String cannot represent a non string value: 0820001234',
        extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
      }),
    ).toEqual({ message: 'Invalid request.', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } });
  });

  it('turns anything unexpected into a generic internal error', () => {
    expect(formatError({ message: 'connect ECONNREFUSED 10.0.0.5:5432' })).toEqual({
      message: 'Something went wrong.',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });

  it('keeps known client errors and their retry hint', () => {
    expect(
      formatError({
        message: 'Too many attempts. Try again later.',
        extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 60, stacktrace: ['x'] },
      }),
    ).toEqual({
      message: 'Too many attempts. Try again later.',
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 60 },
    });
  });
});
