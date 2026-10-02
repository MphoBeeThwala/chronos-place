import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface TsConfigFile {
  extends?: string;
  compilerOptions?: Record<string, unknown>;
}

const root = join(import.meta.dirname, '..');
const read = (name: string): TsConfigFile =>
  JSON.parse(readFileSync(join(root, name), 'utf8')) as TsConfigFile;

describe('@chronos/tsconfig base', () => {
  const options = read('base.json').compilerOptions ?? {};

  it.each([
    'strict',
    'noUncheckedIndexedAccess',
    'exactOptionalPropertyTypes',
    'noImplicitOverride',
    'noImplicitReturns',
    'verbatimModuleSyntax',
  ])('enables %s', (flag) => {
    expect(options[flag]).toBe(true);
  });

  it('never turns strict off in the node preset', () => {
    const node = read('node.json');
    expect(node.extends).toBe('./base.json');
    expect(node.compilerOptions?.['strict']).not.toBe(false);
  });
});
