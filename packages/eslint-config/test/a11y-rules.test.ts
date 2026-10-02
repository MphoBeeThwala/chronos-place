import path from 'node:path';
import { ESLint, type Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import { createConfig } from '../index.mjs';

const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfigFile: true,
  // typescript-eslint's ConfigArray is structurally a Linter.Config[]; its types lag ESLint 10.
  overrideConfig: createConfig({ typed: false }) as unknown as Linter.Config[],
});

async function lint(file: string, code: string): Promise<{ rule: string; message: string }[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(process.cwd(), file) });
  return (result?.messages ?? []).map((m) => ({ rule: m.ruleId ?? 'parse', message: m.message }));
}
const rules = async (file: string, code: string): Promise<string[]> =>
  (await lint(file, code)).map((m) => m.rule);

const SCREEN = 'apps/mobile/app/index.tsx';
const UI = 'packages/ui/src/x.tsx';

describe('chronos/a11y-label', () => {
  it.each([
    ['Pressable', '<Pressable onPress={go} accessibilityRole="button" />'],
    ['TouchableOpacity', '<TouchableOpacity onPress={go} accessibilityRole="button" />'],
    ['Switch', '<Switch value={on} onValueChange={set} />'],
    ['TextInput', '<TextInput value={v} onChangeText={set} />'],
  ])('requires a label on <%s>', async (_name, jsx) => {
    const found = await lint(UI, `export const A = () => ${jsx};\n`);
    expect(
      found.some((m) => m.rule === 'chronos/a11y-label' && /accessible label/.test(m.message)),
    ).toBe(true);
  });

  it('requires a role on pressables', async () => {
    const found = await lint(
      UI,
      'export const A = () => <Pressable accessibilityLabel={label} onPress={go} />;\n',
    );
    expect(found.map((m) => m.message)).toEqual([expect.stringContaining('accessible role')]);
  });

  it('accepts a labelled pressable with a role, in either prop spelling', async () => {
    expect(
      await rules(
        UI,
        'export const A = () => <Pressable accessibilityLabel={label} accessibilityRole="button" onPress={go} />;\n',
      ),
    ).toEqual([]);
    expect(
      await rules(
        UI,
        'export const A = () => <Pressable aria-label="Close" role="button" onPress={go} />;\n',
      ),
    ).toEqual([]);
  });

  it.each([
    'accessibilityLabel=""',
    'accessibilityLabel="  "',
    'accessibilityLabel={undefined}',
    'accessibilityLabel={""}',
  ])('rejects an empty label (%s)', async (attr) => {
    const found = await lint(
      UI,
      `export const A = () => <Pressable ${attr} accessibilityRole="button" />;\n`,
    );
    expect(found.map((m) => m.message)).toEqual([
      expect.stringContaining('empty accessible label'),
    ]);
  });

  it('requires a label on images unless they are marked decorative', async () => {
    expect(
      (await rules(UI, 'export const A = () => <Image source={src} />;\n')).includes(
        'chronos/a11y-label',
      ),
    ).toBe(true);
    expect(
      await rules(UI, 'export const A = () => <Image source={src} accessible={false} />;\n'),
    ).toEqual([]);
    expect(
      await rules(
        UI,
        'export const A = () => <Image source={src} accessibilityLabel={label} />;\n',
      ),
    ).toEqual([]);
  });

  it('skips elements that spread props, which may forward the label', async () => {
    expect(await rules(UI, 'export const A = (p: P) => <Pressable {...p} />;\n')).toEqual([]);
  });

  it('ignores other elements and member expressions', async () => {
    expect(
      await rules(UI, 'export const A = () => <View><Text>{x}</Text><Animated.View /></View>;\n'),
    ).toEqual([]);
  });
});

describe('chronos/no-raw-text', () => {
  it.each([
    ['text in JSX', '<Text>Welcome back</Text>'],
    ['a string in braces', "<Text>{'Welcome back'}</Text>"],
    ['a template literal without expressions', '<Text>{`Welcome back`}</Text>'],
    [
      'an accessibilityLabel literal',
      '<Pressable accessibilityLabel="Close" accessibilityRole="button" />',
    ],
    ['a placeholder literal', '<TextInput accessibilityLabel={label} placeholder="Your name" />'],
    [
      'a braced prop literal',
      '<Pressable accessibilityLabel={"Close"} accessibilityRole="button" />',
    ],
  ])('rejects %s in a screen', async (_name, jsx) => {
    expect(await rules(SCREEN, `export const A = () => ${jsx};\n`)).toContain(
      'chronos/no-raw-text',
    );
  });

  it('accepts text that comes from t(), variables and punctuation', async () => {
    const code = `export const A = () => (
      <View>
        <Text>{t('welcome.title')}</Text>
        <Text>{name}</Text>
        <Text>·</Text>
        <Text>{'—'}</Text>
        <Text>{\`\${count}\`}</Text>
        <Pressable accessibilityLabel={t('close')} accessibilityRole="button" testID="close-button" />
      </View>
    );\n`;
    expect(await rules(SCREEN, code)).toEqual([]);
  });

  it('only applies to screens in apps/, and not to specs', async () => {
    const code = 'export const A = () => <Text>Welcome back</Text>;\n';
    expect(await rules(UI, code)).toEqual([]);
    expect(await rules('apps/mobile/app/index.spec.tsx', code)).toEqual([]);
    expect(await rules('apps/mobile/app/index.tsx', code)).toContain('chronos/no-raw-text');
  });

  it('allows non-user-facing props to hold strings', async () => {
    expect(
      await rules(
        SCREEN,
        'export const A = () => <View testID="home-screen" nativeID="root" />;\n',
      ),
    ).toEqual([]);
  });
});
