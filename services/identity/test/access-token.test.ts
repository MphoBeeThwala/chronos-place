import {
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject,
} from 'node:crypto';
import { GetPublicKeyCommand, type KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  type AccessTokenSigner,
  derToJose,
  InvalidAccessTokenError,
  issueAccessToken,
  KmsAccessTokenSigner,
  LocalAccessTokenSigner,
  thumbprint,
  verifyAccessToken,
} from '../src/sessions/access-token.js';

const NOW = new Date('2026-11-20T10:00:00.000Z');
const subject = {
  accountId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
};

async function keysFor(signer: AccessTokenSigner): Promise<(kid: string) => KeyObject | undefined> {
  const kid = await signer.keyId();
  const key = createPublicKey({ key: await signer.publicJwk(), format: 'jwk' });
  return (k) => (k === kid ? key : undefined);
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const parts = (token: string) => token.split('.') as [string, string, string];

/** A stand-in for KMS: signs with a local key and returns DER, as KMS does. */
function fakeKms(): KMSClient {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    send: (command: unknown) => {
      if (command instanceof GetPublicKeyCommand)
        return Promise.resolve({ PublicKey: publicKey.export({ format: 'der', type: 'spki' }) });
      if (command instanceof SignCommand) {
        const message = Buffer.from(command.input.Message ?? new Uint8Array());
        return Promise.resolve({ Signature: nodeSign('sha256', message, privateKey) });
      }
      return Promise.reject(new Error('unexpected command'));
    },
  } as unknown as KMSClient;
}

describe('access tokens', () => {
  it('carry only ids and times, valid for 10 minutes', async () => {
    const signer = new LocalAccessTokenSigner();
    const { token, expiresAt } = await issueAccessToken(signer, subject, NOW);
    const claims = verifyAccessToken(token, await keysFor(signer), NOW);
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'sid', 'sub']);
    expect(claims.sub).toBe(subject.accountId);
    expect(claims.sid).toBe(subject.sessionId);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(ACCESS_TOKEN_TTL_SECONDS * 1000);
  });

  it('are refused once expired', async () => {
    const signer = new LocalAccessTokenSigner();
    const { token } = await issueAccessToken(signer, subject, NOW);
    const later = new Date(NOW.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000);
    const keys = await keysFor(signer);
    expect(verifyAccessToken(token, keys, new Date(later.getTime() - 1000)).sub).toBe(
      subject.accountId,
    );
    expect(() => verifyAccessToken(token, keys, later)).toThrow(InvalidAccessTokenError);
  });

  it('are refused when the payload is changed', async () => {
    const signer = new LocalAccessTokenSigner();
    const { token } = await issueAccessToken(signer, subject, NOW);
    const [h, , s] = parts(token);
    const forged = `${h}.${b64({ ...JSON.parse(Buffer.from(parts(token)[1], 'base64url').toString()), sub: 'someone-else' })}.${s}`;
    const keys = await keysFor(signer);
    expect(() => verifyAccessToken(forged, keys, NOW)).toThrow(InvalidAccessTokenError);
  });

  it('refuse "none", HS256 and unknown keys', async () => {
    const signer = new LocalAccessTokenSigner();
    const keys = await keysFor(signer);
    const { token } = await issueAccessToken(signer, subject, NOW);
    const [, p] = parts(token);
    const kid = await signer.keyId();
    expect(() => verifyAccessToken(`${b64({ alg: 'none', kid })}.${p}.`, keys, NOW)).toThrow(
      InvalidAccessTokenError,
    );
    const hsInput = `${b64({ alg: 'HS256', kid })}.${p}`;
    const hs = createHmac('sha256', 'guess').update(hsInput).digest('base64url');
    expect(() => verifyAccessToken(`${hsInput}.${hs}`, keys, NOW)).toThrow(InvalidAccessTokenError);
    const other = new LocalAccessTokenSigner();
    const { token: foreign } = await issueAccessToken(other, subject, NOW);
    expect(() => verifyAccessToken(foreign, keys, NOW)).toThrow(InvalidAccessTokenError);
  });

  it('refuse a wrong audience or issuer even when correctly signed', async () => {
    const signer = new LocalAccessTokenSigner();
    const { token } = await issueAccessToken(signer, subject, NOW);
    const [h, p] = parts(token);
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
    const keys = await keysFor(signer);
    for (const change of [{ aud: 'chronos-admin' }, { iss: 'someone' }]) {
      const input = `${h}.${b64({ ...claims, ...change })}`;
      const sig = (await signer.sign(Buffer.from(input))).toString('base64url');
      expect(() => verifyAccessToken(`${input}.${sig}`, keys, NOW)).toThrow(
        InvalidAccessTokenError,
      );
    }
  });

  it('are signed through KMS with DER signatures converted to JOSE form', async () => {
    const signer = new KmsAccessTokenSigner({ client: fakeKms(), keyId: 'alias/test' });
    const { token } = await issueAccessToken(signer, subject, NOW);
    expect(Buffer.from(parts(token)[2], 'base64url')).toHaveLength(64);
    expect(verifyAccessToken(token, await keysFor(signer), NOW).sub).toBe(subject.accountId);
    expect(await signer.keyId()).toBe(thumbprint(await signer.publicJwk()));
  });

  it('convert DER signatures with short or padded integers', () => {
    const r = Buffer.alloc(32, 0);
    r[31] = 1; // a very short r
    const s = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(31, 7)]); // needs a 0x00 pad in DER
    const der = Buffer.concat([Buffer.from([0x30, 2 + 1 + 2 + 33, 0x02, 1, 1, 0x02, 33, 0x00]), s]);
    expect(derToJose(der)).toEqual(Buffer.concat([r, s]));
    expect(() => derToJose(Buffer.from([0x31, 0]))).toThrow();
  });
});
