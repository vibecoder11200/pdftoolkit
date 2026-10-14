import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import { getPageText, pageCountOf } from './helpers/text-assert';

/*
 * Searchable-PDF sandwich e2e (v0.7.0 phase 3, web). Full AI-mock flow with
 * the REAL worker chunk; the PDF button click-time-builds the sandwich from
 * the in-page canvas render and hands it to deliverBytes. The oracle runs
 * on the DELIVERED bytes — the production toBlob path — never a test
 * raster: intercept the download, then extract with pdf.js.
 */

const FIXTURE = 'tests/fixtures/ocr-scan-vn-en.pdf';

test('AI run → quality control → searchable PDF download → pdf.js extraction of the delivered bytes', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('./tools/ocr?ai-mock=1');
  await page.setInputFiles('input[type="file"]', FIXTURE);
  const aiCard = page.locator('label', { hasText: 'AI — GLM-OCR' });
  await expect(aiCard).toBeVisible({ timeout: 20_000 });
  await aiCard.locator('input[type="radio"]').check();

  // AI-engine-only file-quality control: compact default, archive pickable,
  // and the tesseract DPI fieldset is absent for this engine.
  await expect(page.getByTestId('ocr-pdf-quality')).toBeVisible();
  await expect(page.getByTestId('ocr-pdf-quality-compact')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('ocr-pdf-quality-archive').click();
  await expect(page.getByTestId('ocr-pdf-quality-archive')).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: /Tải model và nhận dạng|Download model/i }).click();
  await expect(page.getByTestId('ai-markdown')).toBeVisible({ timeout: 30_000 });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('ai-download-pdf').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-ocr\.pdf$/);
  const bytes = new Uint8Array(readFileSync((await download.path())!));

  // Page count == results (the mock returned one result per input page).
  expect(await pageCountOf(bytes)).toBe(2);
  for (const pageIdx of [1, 2]) {
    const text = await getPageText(bytes, pageIdx);
    // Display text, byte-correct (diacritics from the canned VN table)…
    expect(text).toContain('BÁO CÁO TỒN KHO QUÝ 3/2026');
    expect(text).toContain('Mã hàng Thành tiền (VND)');
    expect(text).toContain('BT-031 12.450.000');
    // …with NO markdown syntax leaking into the searchable layer.
    expect(text).not.toContain('#');
    expect(text).not.toContain('|');
  }
});
