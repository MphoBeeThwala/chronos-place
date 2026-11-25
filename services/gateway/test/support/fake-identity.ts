import { generateKeyPairSync, sign } from 'node:crypto';
import { AccountStatus } from '@chronos/contracts/identity';
import { type AccessTokenSigner, issueAccessToken, thumbprint } from '@chronos/session-tokens';
import {
  loadPackageDefinition,
  Server,
  ServerCredentials,
  type ServiceDefinition,
  status,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { IDENTITY_PROTO } from '../../src/identity/proto.js';

type Handler = (request: Record<string, unknown>) => unknown;

/** A gRPC error a fake handler can throw. */
export class GrpcFailure extends Error {
  readonly code: number;
  constructor(code: number, details: string) {
    super(details);
    this.code = code;
  }
}

/** Local key standing in for identity's KMS signing key. */
export function localSigner(): AccessTokenSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    keyId: () => Promise.resolve(thumbprint(jwk)),
    publicJwk: () => Promise.resolve(jwk),
    sign: (data) =>
      Promise.resolve(sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' })),
  };
}

/**
 * A stand-in for the identity service, speaking the real identity.v1 contract over gRPC.
 * Tests set account statuses and add handlers for the methods they exercise.
 */
export class FakeIdentity {
  readonly signer = localSigner();
  readonly statuses = new Map<string, AccountStatus>();
  readonly handlers = new Map<string, Handler>();
  readonly calls: { method: string; request: Record<string, unknown> }[] = [];
  #server = new Server();
  port = 0;

  async start(): Promise<void> {
    const definition = loadSync(IDENTITY_PROTO, {
      keepCase: false,
      longs: String,
      enums: Number,
      defaults: true,
    });
    const pkg = loadPackageDefinition(definition) as unknown as {
      chronos: { identity: { v1: { IdentityService: { service: ServiceDefinition } } } };
    };
    const { service } = pkg.chronos.identity.v1.IdentityService;
    const implementation = Object.fromEntries(
      Object.values(service).map((method) => {
        const name = method.originalName ?? '';
        return [
          name,
          (
            call: { request: Record<string, unknown> },
            callback: (error: { code: number; details: string } | null, response?: unknown) => void,
          ) => {
            this.calls.push({ method: name, request: call.request });
            this.#handle(name, call.request).then(
              (response) => {
                callback(null, response);
              },
              (error: unknown) => {
                callback(
                  error instanceof GrpcFailure
                    ? { code: error.code, details: error.message }
                    : { code: status.INTERNAL, details: 'fake failure' },
                );
              },
            );
          },
        ];
      }),
    );
    this.#server.addService(service, implementation);
    this.port = await new Promise<number>((resolve, reject) => {
      this.#server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (err, port) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  }

  async #handle(method: string, request: Record<string, unknown>): Promise<unknown> {
    const custom = this.handlers.get(method);
    if (custom) return custom(request);
    if (method === 'getSigningKeys') {
      return {
        keys: [
          {
            kid: await this.signer.keyId(),
            jwkJson: JSON.stringify(await this.signer.publicJwk()),
          },
        ],
      };
    }
    if (method === 'getAccount') {
      const id = String(request['accountId']);
      const accountStatus = this.statuses.get(id);
      if (accountStatus === undefined)
        throw new GrpcFailure(status.NOT_FOUND, 'This account cannot be used.');
      return { account: { accountId: id, status: accountStatus } };
    }
    throw new GrpcFailure(status.UNIMPLEMENTED, 'not in fake');
  }

  /** A session as identity's VerifyOtp and RefreshSession return it. */
  async session(accountId: string, accountStatus: AccountStatus, refreshToken: string) {
    const { token, expiresAt } = await issueAccessToken(
      this.signer,
      { accountId, sessionId: `s-${accountId}` },
      new Date(),
    );
    return {
      account: { accountId, status: accountStatus },
      tokens: {
        accessToken: token,
        accessExpiresAt: expiresAt,
        refreshToken,
        refreshExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      },
    };
  }

  /** An access token for an account, as identity would issue it. */
  async token(accountId: string, now = new Date()): Promise<string> {
    return (await issueAccessToken(this.signer, { accountId, sessionId: `s-${accountId}` }, now))
      .token;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.tryShutdown(() => {
        resolve();
      });
    });
  }
}

export { AccountStatus };
