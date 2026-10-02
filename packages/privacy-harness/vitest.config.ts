import { defineConfig } from 'vitest/config';

// Unit tests of the harness itself. Privacy scenarios (*.privacy.test.ts) run with `pnpm test:privacy`.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.privacy.test.ts'],
    testTimeout: 30_000,
  },
});
