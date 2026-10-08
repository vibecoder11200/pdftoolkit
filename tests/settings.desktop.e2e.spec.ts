import { expect, test, type Page } from '@playwright/test';

/*
 * DESKTOP settings e2e (v0.5.0 phase 5). With __TAURI_INTERNALS__ faked,
 * the Service-Worker precache row must NOT exist on desktop (no SW is ever
 * registered there), while the AI/OCR owned rows render as on web.
 */

async function stubTauri(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: (cmd: string) => {
        if (cmd === 'initial_open_files') return Promise.resolve([]);
        if (cmd === 'plugin:event|listen') return Promise.resolve(1);
        if (cmd === 'plugin:updater|check') return Promise.resolve(null);
        return Promise.resolve(null);
      },
      transformCallback: () => 1,
      convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}`,
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { windowLabel: 'main', label: 'main' },
      },
    };
  });
}

test('precache row hidden on desktop; owned rows present', async ({ page }) => {
  await stubTauri(page);
  await page.goto('/settings?ai-mock=1');
  await expect(page.getByTestId('row-ai-model')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('row-ocr-assets')).toBeVisible();
  await expect(page.getByTestId('row-ocr-idb')).toBeVisible();
  // The SW row does not exist at all on desktop — not "empty", absent.
  await expect(page.getByTestId('row-precache')).toHaveCount(0);
  await expect(page.getByTestId('delete-precache')).toHaveCount(0);
});

test('desktop never registers a service worker from the settings page', async ({ page }) => {
  await stubTauri(page);
  await page.goto('/settings?ai-mock=1');
  await page.getByTestId('row-ai-model').waitFor();
  // Give any (wrong) registration a beat to appear, then assert none did.
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations())).toEqual([]);
});
