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

  it('passes clean code', async () => {
    expect(await lint('export const add = (a: number, b: number): number => a + b;\n')).toEqual([]);
  });
});
