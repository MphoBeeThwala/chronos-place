import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type AccessTokenSigner,
  InvalidAccessTokenError,
  issueAccessToken,
  thumbprint,
  verifyAccessToken,
} from '../src/index.js';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const subject = { accountId: 'acc-1', sessionId: 'ses-1' };

function signer(): AccessTokenSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    keyId: () => Promise.resolve(thumbprint(jwk)),
    publicJwk: () => Promise.resolve(jwk),
    sign: (data) =>
      Promise.resolve(sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' })),
  };
}

async function keys(s: AccessTokenSigner): Promise<(kid: string) => KeyObject | undefined> {
  const kid = await s.keyId();
  const key = createPublicKey({ key: await s.publicJwk(), format: 'jwk' });
  return (k) => (k === kid ? key : undefined);
}

describe('@chronos/session-tokens', () => {
  it('round-trips a token with ids and times only', async () => {
    const s = signer();
    const { token } = await issueAccessToken(s, subject, NOW);
    const claims = verifyAccessToken(token, await keys(s), NOW);
    expect(claims).toMatchObject({
      sub: 'acc-1',
      sid: 'ses-1',
      iss: 'chronos-identity',
      aud: 'chronos-gateway',
    });
  });

  it('refuses tokens from another key, malformed tokens and expired tokens alike', async () => {
    const s = signer();
    const resolve = await keys(s);
    const { token: foreign } = await issueAccessToken(signer(), subject, NOW);
    const { token } = await issueAccessToken(s, subject, NOW);
    for (const bad of [foreign, 'a.b', 'not-a-token', `${token}x`]) {
      expect(() => verifyAccessToken(bad, resolve, NOW)).toThrow(InvalidAccessTokenError);
    }
    expect(() => verifyAccessToken(token, resolve, new Date(NOW.getTime() + 600_000))).toThrow(
      InvalidAccessTokenError,
    );
  });
});
