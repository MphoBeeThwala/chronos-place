import { defineConfig } from 'vitest/config';

// Pure TypeScript tests (tokens, contrast). Component tests run under Jest with jest-expo.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
