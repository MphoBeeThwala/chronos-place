import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  // Next compiles JSX itself (tsconfig "jsx": "preserve"); tests that render components need it here.
  oxc: { jsx: { runtime: 'automatic' } },
  test: { include: ['test/**/*.test.ts'] },
});
