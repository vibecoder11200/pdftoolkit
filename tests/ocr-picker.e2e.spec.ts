import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { pageCountOf } from './helpers/text-assert';

/*
 * Page-range picker e2e (v0.7.0 phase 5): the ThumbnailStrip picker in the
 * OCR config step drives BOTH engine loops through runAiPages' selection
 * option. With the AI mock: clear the all-pages default, pick ONE page of
 * the 12-page fixture, run — exactly one result, and the sandwich PDF has
 * exactly one page (outputs reflect the selection).
 */

test('picker: 1 selected page of the 12-page fixture → 1 result, 1-page PDF', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('./tools/ocr?ai-mock=1');
  await page.setInputFiles('input[type="file"]', 'tests/fixtures/ocr-scan-12p.pdf');
  const aiCard = page.locator('label', { hasText: 'AI — GLM-OCR' });
  await expect(aiCard).toBeVisible({ timeout: 20_000 });
  await aiCard.locator('input[type="radio"]').check();

  // The picker appears once the page probe resolves; the default is ALL.
  await expect(page.getByTestId('ocr-page-picker')).toBeVisible();
  await expect(page.getByTestId('ocr-pages-count')).toContainText('Tất cả 12 trang');

  // Empty the selection, then pick exactly one page.
  await page.getByTestId('ocr-pages-clear').click();
  await expect(page.getByTestId('ocr-pages-count')).toContainText('Đã chọn 0/12 trang');
  await page.getByRole('checkbox').nth(1).click(); // page 2
  await expect(page.getByTestId('ocr-pages-count')).toContainText('Đã chọn 1/12 trang');

  await page.getByRole('button', { name: /Tải model và nhận dạng|Download model/i }).click();
  await expect(page.getByTestId('ai-markdown')).toBeVisible({ timeout: 30_000 });

  // The text join carries exactly ONE page separator (one result).
  await page.getByRole('tab', { name: 'Text' }).click();
  const joined = await page.getByTestId('ai-text').textContent();
  expect(joined?.match(/--- Trang \d+ ---/g)).toHaveLength(1);

  // The sandwich PDF covers exactly the selection.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('ai-download-pdf').click(),
  ]);
  const bytes = new Uint8Array(readFileSync((await download.path())!));
  expect(await pageCountOf(bytes)).toBe(1);
});
