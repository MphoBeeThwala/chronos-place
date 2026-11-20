import {
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { GetPublicKeyCommand, type KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { type AccessTokenSigner, thumbprint } from '@chronos/session-tokens';

// Issuing and verifying live in @chronos/session-tokens, shared with the gateway.
export {
  ACCESS_TOKEN_TTL_SECONDS,
  type AccessClaims,
  type AccessTokenSigner,
  AUDIENCE,
  InvalidAccessTokenError,
  ISSUER,
  issueAccessToken,
  thumbprint,
  verifyAccessToken,
} from '@chronos/session-tokens';

/** KMS returns ECDSA signatures DER-encoded; JWS needs the raw r || s form. */
export function derToJose(der: Uint8Array): Buffer {
  const buf = Buffer.from(der);
  let offset = 0;
  const expect = (tag: number) => {
    if (buf[offset] !== tag) throw new Error('malformed ECDSA signature');
    offset += 1;
  };
  const length = (): number => {
    const first = buf[offset] ?? 0;
    offset += 1;
    if (first < 0x80) return first;
    const bytes = first & 0x7f;
    let value = 0;
    for (let i = 0; i < bytes; i += 1) value = (value << 8) | (buf[offset + i] ?? 0);
    offset += bytes;
    return value;
  };
  const integer = (): Buffer => {
    expect(0x02);
    const len = length();
    let value = buf.subarray(offset, offset + len);
    offset += len;
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) throw new Error('malformed ECDSA signature');
    return Buffer.concat([Buffer.alloc(32 - value.length), value]);
  };
  expect(0x30);
  length();
  return Buffer.concat([integer(), integer()]);
}

/** Signs with a KMS asymmetric key (ECC_NIST_P256, SIGN_VERIFY). The private key never leaves KMS. */
export class KmsAccessTokenSigner implements AccessTokenSigner {
  readonly #client: KMSClient;
  readonly #keyId: string;
  #jwk?: Promise<JsonWebKey>;

  constructor(options: { client: KMSClient; keyId: string }) {
    this.#client = options.client;
    this.#keyId = options.keyId;
  }

  publicJwk(): Promise<JsonWebKey> {
    this.#jwk ??= this.#client
      .send(new GetPublicKeyCommand({ KeyId: this.#keyId }))
      .then(({ PublicKey }) => {
        if (!PublicKey) throw new Error('KMS returned no public key');
        return createPublicKey({ key: Buffer.from(PublicKey), format: 'der', type: 'spki' }).export(
          {
            format: 'jwk',
          },
        );
      });
    return this.#jwk;
  }

  async keyId(): Promise<string> {
    return thumbprint(await this.publicJwk());
  }

  async sign(data: Buffer): Promise<Buffer> {
    const { Signature } = await this.#client.send(
      new SignCommand({
        KeyId: this.#keyId,
        Message: data,
        MessageType: 'RAW',
        SigningAlgorithm: 'ECDSA_SHA_256',
      }),
    );
    if (!Signature) throw new Error('KMS returned no signature');
    return derToJose(Signature);
  }
}

/** An in-process key, for tests and the local stack only. The wiring refuses it elsewhere. */
export class LocalAccessTokenSigner implements AccessTokenSigner {
  readonly #privateKey: KeyObject;
  readonly #jwk: JsonWebKey;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#privateKey = privateKey;
    this.#jwk = publicKey.export({ format: 'jwk' });
  }

  publicJwk(): Promise<JsonWebKey> {
    return Promise.resolve(this.#jwk);
  }

  keyId(): Promise<string> {
    return Promise.resolve(thumbprint(this.#jwk));
  }

  sign(data: Buffer): Promise<Buffer> {
    return Promise.resolve(
      nodeSign('sha256', data, { key: this.#privateKey, dsaEncoding: 'ieee-p1363' }),
    );
  }
}
