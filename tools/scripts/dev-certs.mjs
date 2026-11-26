#!/usr/bin/env node
// Local development certificates for service-to-service mTLS (M2.5): a private CA and one
// certificate per service, written to tools/.certs (git-ignored). Never used outside your machine.
// Re-run with --force to replace them. Needs `openssl` and a built @chronos/service-kit.
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePki } from '../../packages/service-kit/dist/pki.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'tools/.certs');
const SERVICES = [
  'gateway',
  'identity',
  'profile',
  'discovery',
  'matching',
  'messaging',
  'moderation',
  'notifications',
  'payments',
  'disclosure-service',
];

if (existsSync(dir)) {
  if (!process.argv.includes('--force')) {
    process.stdout.write('tools/.certs already exists; pass --force to replace it.\n');
    process.exit(0);
  }
  rmSync(dir, { recursive: true, force: true });
}
generatePki(dir, SERVICES, { days: 90 });
process.stdout.write(
  `Wrote a dev CA and ${String(SERVICES.length)} service certificates to tools/.certs\n`,
);
