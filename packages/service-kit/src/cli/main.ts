#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { generateService } from './new-service.js';

const args = process.argv.slice(2);
const restricted = args.includes('--restricted');
const name = args.find((a) => !a.startsWith('--'));

if (name === undefined) {
  process.stderr.write('usage: pnpm new:service <name> [--restricted]\n');
  process.exit(2);
}

const root = process.cwd();
const digestFile = path.join(root, 'tools/distroless.digest');
const digest = readFileSync(digestFile, 'utf8').trim();

try {
  const target = generateService({ name, root, restricted, distrolessDigest: digest });
  process.stdout.write(
    `Created ${path.relative(root, target)}\nNext: pnpm install, then pnpm --filter @chronos/${name} test\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'failed'}\n`);
  process.exit(1);
}
