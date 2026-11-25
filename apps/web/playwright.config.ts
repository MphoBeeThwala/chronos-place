import { defineConfig, devices } from '@playwright/test';

/**
 * PLAYWRIGHT_CHROME_PATH runs the tests with an installed Chrome where Playwright's own browser
 * cannot be downloaded (e.g. /usr/bin/google-chrome).
 */
const chromePath = process.env['PLAYWRIGHT_CHROME_PATH'];
const launchOptions = chromePath ? { executablePath: chromePath } : {};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : 4,

  use: {
    baseURL: process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },

  reporter: process.env['CI']
    ? [['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list']],

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions } },
    { name: 'Mobile Chrome', use: { ...devices['Pixel 5'], launchOptions } },
  ],

  // CI tests the production build (pnpm build runs first); locally the dev server is enough.
  webServer: {
    command: process.env['CI'] ? 'pnpm start' : 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
