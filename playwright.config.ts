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
  projects: [
    {
      name: 'chromium',
      // The desktop flavor has its own project (served at root, mocked
      // Tauri internals) — keep those specs out of the web run.
      testIgnore: '**/*.desktop.e2e.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'desktop',
      testMatch: '**/*.desktop.e2e.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4181/' },
    },
  ],
  webServer: [
    {
      command: 'npm run preview',
      url: 'http://localhost:4173/pdftoolkit/',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // Builds dist-desktop (desktop flavor) then serves it at the root,
      // like the Tauri webview does.
      command: 'node scripts/build-desktop.mjs && node scripts/preview-desktop.mjs',
      url: 'http://localhost:4181/',
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
  ],
});
