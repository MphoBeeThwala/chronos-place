import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ESLint, type Linter } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConfig } from '../index.mjs';

let root: string;
let eslint: ESLint;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'chronos-boundary-'));
  mkdirSync(path.join(root, 'restricted/disclosure-service'), { recursive: true });
  mkdirSync(path.join(root, 'restricted/vault-db'), { recursive: true });
  writeFileSync(
    path.join(root, 'restricted/disclosure-service/package.json'),
    JSON.stringify({ name: '@chronos/disclosure-service' }),
  );
  writeFileSync(
    path.join(root, 'restricted/vault-db/package.json'),
    JSON.stringify({ name: '@chronos/vault-db' }),
  );
  eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    // typescript-eslint's ConfigArray is structurally a Linter.Config[]; its types lag ESLint 10.
    overrideConfig: createConfig({ typed: false, rootDir: root }) as unknown as Linter.Config[],
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Lints `code` as if it lived at `file` (repo-relative) and returns "ruleId:messageId" pairs. */
async function lint(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
  return (result?.messages ?? []).map((m) => `${m.ruleId ?? 'none'}:${m.messageId ?? m.message}`);
}

const BOUNDARY = 'chronos/restricted-boundary';

describe('outside restricted/', () => {
  it.each([
    [
      "import { x } from '../../../restricted/disclosure-service/src/x';",
      'services/profile/src/a.ts',
    ],
    ["import { x } from '@chronos/disclosure-service';", 'services/profile/src/a.ts'],
    ["import { x } from '@chronos/vault-db/schema';", 'apps/admin/src/a.ts'],
    ["import { x } from 'restricted/vault-db';", 'services/profile/src/a.ts'],
    ["import type { T } from '@chronos/disclosure-service';", 'services/profile/src/a.ts'],
    ["export * from '@chronos/vault-db';", 'services/profile/src/a.ts'],
    ["export { x } from '@chronos/vault-db';", 'services/profile/src/a.ts'],
    ["export const m = () => import('@chronos/vault-db');", 'services/profile/src/a.ts'],
    ["const m = require('@chronos/vault-db');", 'services/profile/src/a.cjs'],
    ["import m = require('@chronos/vault-db');\nexport { m };", 'services/profile/src/a.ts'],
    ["export type T = typeof import('@chronos/vault-db');", 'services/profile/src/a.ts'],
    ['export const m = () => import(`@chronos/vault-db`);', 'services/profile/src/a.ts'],
  ])('rejects: %s', async (code, file) => {
    expect(await lint(file, `${code}\n`)).toContain(`${BOUNDARY}:restrictedImport`);
  });

  it('allows ordinary imports', async () => {
    const code =
      "import { readFile } from 'node:fs/promises';\nimport { x } from './local';\nexport { readFile, x };\n";
    expect(await lint('services/profile/src/a.ts', code)).toEqual([]);
  });

  it('rejects non-literal dynamic imports and requires', async () => {
    const dyn = 'export const m = (n: string) => import(n);\n';
    const req = 'export const m = (n: string) => require(n);\n';
    expect(await lint('services/profile/src/a.ts', dyn)).toContain(`${BOUNDARY}:nonLiteral`);
    expect(await lint('services/profile/src/b.ts', req)).toContain(`${BOUNDARY}:nonLiteral`);
  });

  it('permits non-literal dynamic imports in tools/', async () => {
    const dyn = 'export const m = (n: string) => import(n);\n';
    expect(await lint('tools/seed/a.ts', dyn)).toEqual([]);
  });
});

describe('Disclosure client', () => {
  const code = "import { client } from '@chronos/contracts/disclosure';\nexport { client };\n";

  it.each(['services/gateway', 'services/discovery', 'services/identity', 'services/moderation'])(
    'is allowed in %s',
    async (dir) => {
      expect(await lint(`${dir}/src/a.ts`, code)).toEqual([]);
    },
  );

  it.each(['services/profile', 'services/matching', 'services/messaging', 'apps/mobile'])(
    'is rejected in %s',
    async (dir) => {
      expect(await lint(`${dir}/src/a.ts`, code)).toContain(`${BOUNDARY}:disclosureClient`);
    },
  );

  it('is rejected for subpaths from unapproved services', async () => {
    const sub = "import { c } from '@chronos/contracts/disclosure/v1';\nexport { c };\n";
    expect(await lint('services/profile/src/a.ts', sub)).toContain(`${BOUNDARY}:disclosureClient`);
  });
});

describe('inside restricted/', () => {
  const file = 'restricted/disclosure-service/src/a.ts';

  it.each([
    "import { createHash } from 'node:crypto';",
    "import { z } from 'zod';",
    "import { logger } from '@chronos/logger';",
    "import { seal } from '@chronos/crypto';",
    "import { client } from '@chronos/contracts/disclosure';",
    "import { schema } from '@chronos/vault-db';",
    "import { Injectable } from '@nestjs/common';",
    "import { x } from '../../vault-db/src/x';",
    "import { y } from './y';",
  ])('allows: %s', async (code) => {
    const names = code.match(/\{ (\w+) \}/)?.[1] ?? 'x';
    expect(await lint(file, `${code}\nexport { ${names} };\n`)).toEqual([]);
  });

  it.each([
    ["import _ from 'lodash';", 'lodash'],
    ["import { p } from '@chronos/profile';", 'core service package'],
    ["import { p } from '../../../services/profile/src/p';", 'core service by path'],
    ["import { Kafka } from 'kafkajs';", 'kafka'],
  ])('rejects: %s (%s)', async (code) => {
    const result = await lint(file, `${code}\n`);
    expect(result).toContain(`${BOUNDARY}:notAllowedInRestricted`);
  });
});

describe('the rule cannot be disabled', () => {
  const violation = "import { x } from '@chronos/vault-db';\nexport { x };\n";

  it('rejects a rule-specific disable comment', async () => {
    const code = `// eslint-disable-next-line chronos/restricted-boundary -- need it\n${violation}`;
    const result = await lint('services/profile/src/a.ts', code);
    expect(
      result.some((r) => r.startsWith('@eslint-community/eslint-comments/no-restricted-disable')),
    ).toBe(true);
  });

  it('rejects a blanket disable comment', async () => {
    const result = await lint('services/profile/src/a.ts', `/* eslint-disable */\n${violation}`);
    expect(
      result.some((r) => r.startsWith('@eslint-community/eslint-comments/no-unlimited-disable')),
    ).toBe(true);
  });
});

describe('repository config', () => {
  it('has a single root ESLint config, so no workspace can drop the rule', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', '.turbo', 'dist'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/^eslint\.config\.(m|c)?(j|t)s$/.test(entry.name))
          found.push(path.relative(repoRoot, full));
      }
    };
    walk(repoRoot);
    expect(found).toEqual(['eslint.config.mjs']);
  });
});
