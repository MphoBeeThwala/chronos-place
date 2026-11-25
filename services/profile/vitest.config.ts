import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts', 'test/**/*.privacy.test.ts'],
    testTimeout: 20_000,
  },
});
