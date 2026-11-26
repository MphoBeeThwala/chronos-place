import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts', 'test/**/*.privacy.test.ts'],
    testTimeout: 20_000,
    // M2.3 AC: every branch of the access decision is tested.
    coverage: {
      provider: 'v8',
      include: ['src/access/decide.ts'],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
});
