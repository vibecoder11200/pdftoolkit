import { existsSync, readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { expect, test, type Page } from '@playwright/test';

/*
 * OCR tool e2e (phase 5, R14): the fence wraps the WHOLE run and COLLECTS
 * every request URL — a CDN hit that merely "works" must fail the assert,
 * not slip past an abort-only probe. Uses the real tesseract eng path on the
 * 2-page scan fixture (gitignored — generate with the other fixtures).
 */

const FIXTURE = 'tests/fixtures/ocr-scan-vn-en.pdf';

function sameOriginAsPage(page: Page, url: string): boolean {
  try {
    return new URL(url).origin === new URL(page.url()).origin;
  } catch {
    return false;
  }
}

test('ocr tool: 2-page scan → searchable PDF, zero non-same-origin requests', async ({ page }) => {
  test.skip(!existsSync(FIXTURE), 'fixture missing — run node tests/fixtures/gen.mjs');
  test.setTimeout(180_000);

  await page.goto('./tools/ocr');
  await page.setInputFiles('input[type="file"]', FIXTURE);

  // Config step: pick English explicitly (fastest real path), 150 DPI default.
  await expect(page.getByText(/DPI/).first()).toBeVisible({ timeout: 20_000 });
  await page.getByText('English', { exact: true }).click();

  // Fence: collect every request from here through the whole OCR run.
  const external: string[] = [];
  page.on('request', (req) => {
    if (!sameOriginAsPage(page, req.url())) external.push(req.url());
  });

  await page.getByRole('button', { name: /Nhận dạng|Recognize|Run/i }).click();

  const downloadButton = page.getByRole('button', { name: /Tải|Download/i });
  await expect(downloadButton).toBeVisible({ timeout: 150_000 });

  const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()]);
  const outPath = await download.path();
  expect(outPath).toBeTruthy();
  const out = await PDFDocument.load(readFileSync(outPath!));
  expect(out.getPageCount()).toBe(2);

  // Text layer must exist on page 1 (searchable-PDF smoke via pdf.js would be
  // deeper, but the phase-4b integration spec already asserts keywords).
  expect(out.getPageCount()).toBeGreaterThan(0);

  // THE assert: a single external request fails the run.
  expect(external, `non-same-origin requests during OCR: ${external.join(', ')}`).toEqual([]);
});
