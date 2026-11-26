import { defineConfig } from 'vitest/config';

/** The M3.2 speed test: seeds 200,000 synthetic members, so it runs on its own (`pnpm test:speed`). */
export default defineConfig({
  test: {
    include: ['test/**/*.speed.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
