import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

/*
 * Web invisibility proofs (v0.6.0 phase 6, R6.4 — contract acceptance 4's
 * web half): the WEB build (chromium project, /pdftoolkit/ base) has NO
 * native radio, NO suggestion card under ANY benchmark fixture, NO settings
 * native card. `window.__TAURI_INTERNALS__` is deliberately absent — that
 * absence IS the feature gate.
 */

const FIXTURE = 'tests/fixtures/fixture-small.pdf';
const PKG_VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version as string;

test.describe('native engine is invisible on web', () => {
  test('ocr tool: no native radio and no suggestion card (weak benchmark seeded)', async ({
    page,
  }) => {
    // Seed a WEAK record via IndexedDB — on desktop this shows the card;
    // on web nothing may appear (isTauri() gate).
    await page.addInitScript(() => {
      const open = indexedDB.open('pdftoolkit-ai', 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('benchmarks'))
          open.result.createObjectStore('benchmarks');
      };
      open.onsuccess = () => {
        const db = open.result;
        db.transaction('benchmarks', 'readwrite')
          .objectStore('benchmarks')
          .put(
            {
              modelId: 'glm-ocr',
              tokPerSecWarm: 8,
              firstTokenColdMs: 900,
              condition: 'wasm',
              measuredAt: Date.now(),
              adapterFingerprint: '?|?|?',
            },
            'benchmark/v2/glm-ocr/?|?|?',
          );
        db.close();
      };
    });
    await page.goto('./tools/ocr');
    await page.setInputFiles('input[type="file"]', FIXTURE);
    // The two web engines render; the third radio must not exist.
    await expect(page.getByRole('radio', { name: /Tesseract/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: /AI — GLM-OCR/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: /AI Native/ })).toHaveCount(0);
    await expect(page.getByTestId('native-suggest-card')).toHaveCount(0);
  });

  test('settings: no native card, no native storage row', async ({ page }) => {
    await page.goto('./settings');
    await expect(page.getByTestId('settings-rows')).toBeVisible();
    await expect(page.getByTestId('native-engine-card')).toHaveCount(0);
    await expect(page.getByTestId('row-native-engine')).toHaveCount(0);
    // Sanity: the page is the real web settings (version chip renders).
    await expect(page.getByTestId('footer-version')).toContainText(PKG_VERSION);
  });
});
