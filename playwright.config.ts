import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  // Only the browser e2e suite; engine/matrix specs belong to vitest.
  testMatch: '**/*.e2e.spec.ts',
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:4173/pdftoolkit/',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173/pdftoolkit/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
