import js from '@eslint/js';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const TS_FILES = ['**/*.{ts,tsx,mts,cts}'];

/**
 * Shared ESLint flat config for every Chronos Place workspace.
 *
 * @param {{ tsconfigRootDir?: string, typed?: boolean }} [options]
 *   `typed: false` skips type-aware rules (used by this package's own tests).
 */
export function createConfig(options = {}) {
  const { tsconfigRootDir, typed = true } = options;

  return tseslint.config(
    { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**'] },
    js.configs.recommended,
    comments.recommended,
    typed
      ? tseslint.configs.strictTypeChecked.map((c) => ({ ...c, files: TS_FILES }))
      : tseslint.configs.strict.map((c) => ({ ...c, files: TS_FILES })),
    {
      languageOptions: {
        globals: { ...globals.node },
        ...(typed
          ? {
              parserOptions: {
                projectService: true,
                ...(tsconfigRootDir ? { tsconfigRootDir } : {}),
              },
            }
          : {}),
      },
      linterOptions: { reportUnusedDisableDirectives: 'error' },
      rules: {
        // Rule 4: services log through @chronos/logger only.
        'no-console': 'error',
        // Escape hatches must say why (CLAUDE.md: no `any` without an explanation).
        '@eslint-community/eslint-comments/require-description': 'error',
        '@eslint-community/eslint-comments/disable-enable-pair': [
          'error',
          { allowWholeFile: true },
        ],
      },
    },
    {
      files: TS_FILES,
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/consistent-type-imports': 'error',
      },
    },
    {
      // Plain JS config files are not part of any tsconfig project.
      files: ['**/*.{js,mjs,cjs}'],
      ...tseslint.configs.disableTypeChecked,
    },
  );
}
