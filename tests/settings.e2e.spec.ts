import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { formatBytes } from '../src/lib/format';

/*
 * Settings / storage manager e2e (v0.5.0 phase 5, F14/F15). Stores are
 * seeded from inside the page: the AI row's size is manifest ∩ cache, so
 * TINY bodies with the exact hfFileUrl keys make the row report the full
 * manifest total without downloading 628MB. Unknown stores (a sibling
 * github.io app + a foreign IDB) must render display-only. The delete flow
 * ends on the OCR tool asserting the store-based "ready" chip is GONE —
 * the honest "re-download" contract.
 */

const MANIFEST = JSON.parse(readFileSync('scripts/ai-model-manifest.json', 'utf8')) as {
  repo: string;
  revision: string;
  files: { path: string; size: number }[];
};
const AI_TOTAL = MANIFEST.files.reduce((s, f) => s + f.size, 0);
const AI_URLS = MANIFEST.files.map(
  (f) => `https://huggingface.co/${MANIFEST.repo}/resolve/${MANIFEST.revision}/${f.path}`,
);

const OCR_BODY = 50_000; // fake tessdata pin
const IDB_BODY = 40_000; // fake gunzipped traineddata

async function seedStores(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(
    async ({ aiUrls, ocrBody, idbBody }) => {
      // SW must be controlling BEFORE the reload so the precache row mounts
      // in its present state (not a registration race).
      await navigator.serviceWorker.ready;

      const ai = await caches.open('pdftoolkit-ai-v1');
      for (const url of aiUrls) await ai.put(url, new Response('seed'));
      await ai.put('https://huggingface.co/extra/leftover', new Response('seed'));

      const ocr = await caches.open('pdftoolkit-ocr-v1');
      await ocr.put(
        `${location.origin}/pdftoolkit/tesseract-core/seed.wasm.js`,
        new Response('x'.repeat(ocrBody)),
      );

      await caches.open('sibling-app-v1').then((c) => c.put(`${location.origin}/x`, new Response('s')));

      // unknown IndexedDB (foreign origin-mate)
      await new Promise<void>((resolve) => {
        const req = indexedDB.open('not-ours-db', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('stuff');
        req.onsuccess = req.onerror = () => {
          req.result.close();
          resolve();
        };
      });

      // tesseract's keyval-store with one ArrayBuffer value
      await new Promise<void>((resolve) => {
        const req = indexedDB.open('keyval-store', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('keyval');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('keyval', 'readwrite');
          tx.objectStore('keyval').put(new ArrayBuffer(idbBody), 'eng.traineddata');
          tx.oncomplete = tx.onerror = tx.onabort = () => {
            db.close();
            resolve();
          };
        };
        req.onerror = () => resolve();
      });
    },
    { aiUrls: AI_URLS, ocrBody: OCR_BODY, idbBody: IDB_BODY },
  );
  await page.reload();
}

test('storage rows: owned allowlist with honest sources, unknown display-only', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('./settings?ai-mock=1');
  await seedStores(page);

  // AI row: manifest ∩ cache total (tiny seeded bodies, manifest sizes)
  const aiRow = page.getByTestId('row-ai-model');
  await expect(aiRow).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('size-ai-model')).toHaveText(formatBytes(AI_TOTAL));

  // OCR cache row: directly measured bytes
  await expect(page.getByTestId('row-ocr-assets')).toBeVisible();
  await expect(page.getByTestId('size-ocr-assets')).toHaveText(formatBytes(OCR_BODY));

  // OCR IDB row: measured ArrayBuffer bytes
  await expect(page.getByTestId('row-ocr-idb')).toBeVisible();
  await expect(page.getByTestId('size-ocr-idb')).toHaveText(formatBytes(IDB_BODY));

  // SW precache row (web project: SW controls /pdftoolkit/)
  await expect(page.getByTestId('row-precache')).toBeVisible();
  await expect(page.getByTestId('delete-precache')).toBeVisible();

  // unknown stores: listed, but ZERO delete affordances inside the block
  const unknown = page.getByTestId('settings-unknown');
  await expect(unknown).toBeVisible();
  await expect(unknown).toContainText('sibling-app-v1');
  await expect(unknown).toContainText('not-ours-db');
  await expect(unknown.getByRole('button')).toHaveCount(0);

  // quota bar + in-memory note
  await expect(page.getByTestId('settings-quota')).toBeVisible();
  await expect(page.getByText(/Zip\/ảnh thumbnail/)).toBeVisible();
});

test('delete AI model → store gone → OCR tool shows the download state again', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('./settings?ai-mock=1');
  await seedStores(page);
  await expect(page.getByTestId('size-ai-model')).toHaveText(formatBytes(AI_TOTAL));

  await page.getByTestId('delete-ai-model').click();
  await expect(page.getByTestId('size-ai-model')).toHaveText('Chưa tải', { timeout: 20_000 });
  expect(await page.evaluate(() => caches.has('pdftoolkit-ai-v1'))).toBe(false);

  // OCR tool: the ready chip is STORE-derived — it must be gone too.
  await page.goto('./tools/ocr?ai-mock=1');
  await page.setInputFiles('input[type="file"]', 'tests/fixtures/fixture-small.pdf');
  const aiCard = page.locator('label', { hasText: 'AI — GLM-OCR' });
  await expect(aiCard).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Sẵn sàng (offline)')).toHaveCount(0);
});

test('axe: settings page has no serious/critical violations', async ({ page }) => {
  await page.goto('./settings?ai-mock=1');
  await page.getByTestId('settings-rows').waitFor();
  const { AxeBuilder } = await import('@axe-core/playwright');
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) =>
    v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious).toEqual([]);
});

test('locale: EN toggle switches the settings copy', async ({ page }) => {
  await page.goto('./settings?ai-mock=1');
  await page.getByTestId('settings-rows').waitFor();
  await page.getByRole('button', { name: 'EN' }).click();
  await expect(page.getByRole('heading', { name: 'Storage on this device' })).toBeVisible();
  await expect(page.getByTestId('row-ai-model')).toContainText('AI OCR model (GLM-OCR)');
  await expect(page.getByTestId('size-ai-model')).toHaveText('Not downloaded');
});
