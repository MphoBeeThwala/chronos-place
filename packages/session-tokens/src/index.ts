import {
  createHash,
  randomUUID,
  verify as nodeVerify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

/**
 * Member access tokens: compact JWS, ES256, 10 minutes (ADR-0018). Claims carry ids and times only,
 * never a phone number, status or other personal data. Identity issues them; the gateway verifies.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
export const ISSUER = 'chronos-identity';
export const AUDIENCE = 'chronos-gateway';

export interface AccessClaims {
  iss: string;
  aud: string;
  /** Account id. */
  sub: string;
  /** Session id. */
  sid: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface AccessTokenSigner {
  /** RFC 7638 thumbprint of the public key; the token's `kid` header. */
  keyId(): Promise<string>;
  publicJwk(): Promise<JsonWebKey>;
  /** ECDSA P-256 / SHA-256 signature in JOSE form (r || s, 64 bytes). */
  sign(data: Buffer): Promise<Buffer>;
}

const b64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

/** RFC 7638 JWK thumbprint for an EC key. */
export function thumbprint(jwk: JsonWebKey): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash('sha256').update(canonical).digest('base64url');
}

export async function issueAccessToken(
  signer: AccessTokenSigner,
  subject: { accountId: string; sessionId: string },
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(now.getTime() / 1000);
  const claims: AccessClaims = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: subject.accountId,
    sid: subject.sessionId,
    iat,
    exp: iat + ACCESS_TOKEN_TTL_SECONDS,
    jti: randomUUID(),
  };
  const header = { alg: 'ES256', typ: 'JWT', kid: await signer.keyId() };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = await signer.sign(Buffer.from(input));
  return { token: `${input}.${b64url(signature)}`, expiresAt: new Date(claims.exp * 1000) };
}

export class InvalidAccessTokenError extends Error {
  constructor() {
    super('invalid access token');
    this.name = 'InvalidAccessTokenError';
  }
}

const decodeJson = (part: string): unknown =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/**
 * Verifies a token for the gateway: ES256 only (no "none", no algorithm switching), a known key
 * id, issuer, audience and expiry. Throws InvalidAccessTokenError without saying which check failed.
 */
export function verifyAccessToken(
  token: string,
  resolveKey: (kid: string) => KeyObject | undefined,
  now: Date,
): AccessClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new InvalidAccessTokenError();
  const [h = '', p = '', s = ''] = parts;
  try {
    const header = decodeJson(h) as { alg?: unknown; kid?: unknown };
    if (header.alg !== 'ES256' || typeof header.kid !== 'string') throw new Error('header');
    const key = resolveKey(header.kid);
    if (!key) throw new Error('key');
    const ok = nodeVerify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    if (!ok) throw new Error('signature');
    const claims = decodeJson(p) as Partial<AccessClaims>;
    const at = Math.floor(now.getTime() / 1000);
    if (
      claims.iss !== ISSUER ||
      claims.aud !== AUDIENCE ||
      typeof claims.sub !== 'string' ||
      typeof claims.sid !== 'string' ||
      typeof claims.exp !== 'number' ||
      claims.exp <= at
    ) {
      throw new Error('claims');
    }
    return claims as AccessClaims;
  } catch {
    throw new InvalidAccessTokenError();
  }
}
