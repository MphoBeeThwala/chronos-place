import { createConfig } from '@chronos/eslint-config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default [
  { ignores: ['.next/**', 'next-env.d.ts', 'playwright-report/**', 'test-results/**'] },
  ...createConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    // WCAG 2.2 AA (CLAUDE.md coding standards): accessibility lint on every component.
    files: ['src/**/*.tsx'],
    ...jsxA11y.flatConfigs.strict,
    languageOptions: {
      ...jsxA11y.flatConfigs.strict.languageOptions,
      globals: { ...globals.browser },
    },
  },
  {
    // Build and test tooling runs outside the app and is not service code, so it may read process.env.
    // Runtime code under src/ still reads configuration through @chronos/config.
    files: ['next.config.ts', 'playwright.config.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
];
