/**
 * A private CA and one certificate per service, for local development (`pnpm dev:certs`) and tests.
 * Never for deployed environments, whose certificates come from the platform's CA. Uses the
 * `openssl` command line. Keys are EC P-256; certificates carry `spiffe://<trust domain>/<service>`
 * plus `localhost` and `127.0.0.1`, for both server and client use.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_TRUST_DOMAIN, spiffeId } from './caller-identity.js';

export interface ServiceCertificate {
  cert: string;
  key: string;
}
export interface Pki {
  dir: string;
  ca: string;
  services: Record<string, ServiceCertificate>;
}

const run = (args: string[]): void => {
  execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
};

export function generatePki(
  dir: string,
  services: readonly string[],
  { trustDomain = DEFAULT_TRUST_DOMAIN, days = 365, caName = 'Chronos Place dev CA' } = {},
): Pki {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ca = path.join(dir, 'ca.pem');
  const caKey = path.join(dir, 'ca.key');
  run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', caKey]);
  run([
    'req',
    '-x509',
    '-new',
    '-key',
    caKey,
    '-out',
    ca,
    '-days',
    String(days),
    '-subj',
    `/CN=${caName}`,
    '-addext',
    'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  const issued: Record<string, ServiceCertificate> = {};
  for (const service of services) {
    const key = path.join(dir, `${service}.key`);
    const csr = path.join(dir, `${service}.csr`);
    const cert = path.join(dir, `${service}.pem`);
    const ext = path.join(dir, `${service}.ext`);
    writeFileSync(
      ext,
      [
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature',
        'extendedKeyUsage=serverAuth,clientAuth',
        `subjectAltName=URI:${spiffeId(service, trustDomain)},DNS:localhost,IP:127.0.0.1`,
      ].join('\n'),
    );
    run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
    run(['req', '-new', '-key', key, '-out', csr, '-subj', `/CN=${service}`]);
    run([
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      ca,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-out',
      cert,
      '-days',
      String(days),
      '-extfile',
      ext,
    ]);
    issued[service] = { cert, key };
  }
  return { dir, ca, services: issued };
}
