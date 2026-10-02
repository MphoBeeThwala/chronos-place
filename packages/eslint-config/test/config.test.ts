import path from 'node:path';
import { ESLint, type Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import { createConfig } from '../index.mjs';

const eslint = new ESLint({
  overrideConfigFile: true,
  // typescript-eslint's ConfigArray is structurally a Linter.Config[]; its types lag ESLint 10.
  overrideConfig: createConfig({ typed: false }) as unknown as Linter.Config[],
});

async function lint(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: 'fixture.ts' });
  return (result?.messages ?? []).map((m) => m.ruleId ?? m.message);
}

async function lintAt(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(process.cwd(), file) });
  return (result?.messages ?? []).map((m) => m.ruleId ?? m.message);
}

describe('@chronos/eslint-config', () => {
  it('bans console in service code', async () => {
    expect(await lint("console.log('x');\n")).toContain('no-console');
  });

  it('bans explicit any', async () => {
    expect(await lint('export const a: any = 1;\n')).toContain(
      '@typescript-eslint/no-explicit-any',
    );
  });

  it('requires a reason when disabling a rule', async () => {
    const rules = await lint(
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport const a: any = 1;\n',
    );
    expect(rules).toContain('@eslint-community/eslint-comments/require-description');
  });

  it('accepts any with an explained disable', async () => {
    const rules = await lint(
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any -- third-party payload is untyped\nexport const a: any = 1;\n',
    );
    expect(rules).toEqual([]);
  });

  it('reports disable directives that suppress nothing', async () => {
    const rules = await lint(
      '// eslint-disable-next-line no-console -- stale\nexport const a = 1;\n',
    );
    expect(rules).toContain(
      "Unused eslint-disable directive (no problems were reported from 'no-console').",
    );
  });

  it('bans process.env in service code but not in packages', async () => {
    const code = "export const url = process.env['DATABASE_URL'];\n";
    const inService = await lintAt('services/profile/src/a.ts', code);
    const inPackage = await lintAt('packages/config/src/a.ts', code);
    expect(inService).toContain('no-restricted-syntax');
    expect(inPackage).not.toContain('no-restricted-syntax');
  });

  it('passes clean code', async () => {
    expect(await lint('export const add = (a: number, b: number): number => a + b;\n')).toEqual([]);
  });
});
