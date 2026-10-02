import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { findViolations, type Manifest, type Policy } from './banned-dependencies.js';

// dist/ lives at tools/repo-checks/dist, three levels below the repository root.
const root = path.resolve(import.meta.dirname, '../../..');
const IGNORED = new Set(['node_modules', '.git', '.turbo', 'dist', 'gen', 'coverage']);

function manifests(dir: string): Manifest[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return IGNORED.has(entry.name) ? [] : manifests(full);
    if (entry.name !== 'package.json') return [];
    return [
      {
        file: path.relative(root, full),
        content: JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>,
      },
    ];
  });
}

const policy = JSON.parse(
  readFileSync(path.join(root, 'tools/repo-checks/banned-dependencies.json'), 'utf8'),
) as Policy;
const adrDir = path.join(root, 'docs/adr');
const adrExists = (adr: string): boolean =>
  existsSync(adrDir) &&
  readdirSync(adrDir).some((f) =>
    f.toLowerCase().startsWith(`${adr.toLowerCase().replace('adr-', '')}-`),
  );

const violations = findViolations(manifests(root), policy, adrExists);
if (violations.length > 0) {
  process.stderr.write(
    'Banned dependencies (CLAUDE.md rule 7). Propose an ADR before adding an SDK that phones home:\n',
  );
  for (const v of violations) process.stderr.write(`  ${v.file}: ${v.dependency} (${v.reason})\n`);
  process.exit(1);
}
process.stdout.write(
  `No banned dependencies in ${String(manifests(root).length)} package.json files.\n`,
);
