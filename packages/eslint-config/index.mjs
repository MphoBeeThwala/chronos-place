import js from '@eslint/js';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import path from 'node:path';
import tseslint from 'typescript-eslint';
import { a11yLabel } from './rules/a11y-label.mjs';
import { noRawText } from './rules/no-raw-text.mjs';
import { restrictedBoundary } from './rules/restricted-boundary.mjs';

const TS_FILES = ['**/*.{ts,tsx,mts,cts}'];
const DEFAULT_ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * Shared ESLint flat config for every Chronos Place workspace.
 *
 * @param {{ tsconfigRootDir?: string, typed?: boolean, rootDir?: string }} [options]
 *   `typed: false` skips type-aware rules (used by this package's own tests).
 *   `rootDir` is the repository root used by the restricted-zone boundary rule.
 */
export function createConfig(options = {}) {
  const { tsconfigRootDir, typed = true, rootDir = DEFAULT_ROOT } = options;

  return tseslint.config(
    // `gen/` holds generated code (protobuf); it is reviewed as .proto source, not as TypeScript.
    {
      ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**', '**/gen/**'],
    },
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
      plugins: {
        chronos: {
          rules: {
            'restricted-boundary': restrictedBoundary,
            'a11y-label': a11yLabel,
            'no-raw-text': noRawText,
          },
        },
      },
      rules: {
        // CLAUDE.md rule 1: the boundary rule can never be switched off inline.
        'chronos/restricted-boundary': ['error', { root: rootDir }],
        '@eslint-community/eslint-comments/no-restricted-disable': ['error', 'chronos/*'],
        '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
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
      // Service code reads configuration only through @chronos/config, so invalid config stops start-up.
      files: ['services/**', 'restricted/**', 'apps/**'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: "MemberExpression[object.name='process'][property.name='env']",
            message: 'Read configuration through @chronos/config, not process.env.',
          },
        ],
      },
    },
    {
      // Jest (jest-expo) tests and setup files in React Native packages.
      files: ['**/*.spec.{ts,tsx}', '**/jest.setup.cjs'],
      languageOptions: { globals: { ...globals.jest } },
    },
    {
      // Accessibility (PRD: WCAG 2.2 AA): interactive elements and images carry labels and roles.
      files: ['**/*.tsx'],
      rules: { 'chronos/a11y-label': 'error' },
    },
    {
      // Screens take every word from the translation catalogues.
      files: ['apps/**/*.tsx'],
      ignores: ['**/*.spec.tsx', '**/*.test.tsx'],
      rules: { 'chronos/no-raw-text': 'error' },
    },
    {
      ...reactHooks.configs.flat.recommended,
      files: ['apps/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    },
    {
      files: TS_FILES,
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/consistent-type-imports': 'error',
        // NestJS modules and providers are decorated classes, often with no members.
        '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      },
    },
    {
      // Plain JS config files are not part of any tsconfig project.
      files: ['**/*.{js,mjs,cjs}'],
      ...tseslint.configs.disableTypeChecked,
    },
  );
}
