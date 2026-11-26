import { readFileSync } from 'node:fs';
import { credentials, type ChannelCredentials } from '@grpc/grpc-js';
import { DEFAULT_TRUST_DOMAIN, serviceFromSubjectAltName } from './caller-identity.js';

export interface ClientTlsConfig {
  GRPC_TLS_CERT_PATH?: string | undefined;
  GRPC_TLS_KEY_PATH?: string | undefined;
  GRPC_TLS_CA_PATH?: string | undefined;
  GRPC_TRUST_DOMAIN?: string | undefined;
}

/**
 * Credentials for calling another service: this service's own certificate (so the server knows who
 * is calling) and the CA, and the server must present `spiffe://<trust domain>/<expectedServer>`
 * (not just any certificate from our CA). Insecure only when no certificate is configured, which
 * the kit's config allows in local and test alone.
 */
export function grpcClientCredentials(
  config: ClientTlsConfig,
  expectedServer: string,
): ChannelCredentials {
  const { GRPC_TLS_CERT_PATH: cert, GRPC_TLS_KEY_PATH: key, GRPC_TLS_CA_PATH: ca } = config;
  if (cert === undefined || key === undefined || ca === undefined) {
    return credentials.createInsecure();
  }
  const trustDomain = config.GRPC_TRUST_DOMAIN ?? DEFAULT_TRUST_DOMAIN;
  return credentials.createSsl(readFileSync(ca), readFileSync(key), readFileSync(cert), {
    checkServerIdentity: (_host, peer) =>
      serviceFromSubjectAltName(peer.subjectaltname, trustDomain) === expectedServer
        ? undefined
        : new Error('unexpected server identity'),
  });
}
