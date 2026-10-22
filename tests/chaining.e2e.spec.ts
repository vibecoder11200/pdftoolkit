import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/*
 * Chaining e2e (v0.8.0 phase 5, acceptance criterion 3): merge → "Tiếp tục
 * với kết quả" chip → picker (PDF-intake takers ONLY — ocr and img-to-pdf
 * must be absent, D2) → page-numbers → the merged file auto-takes through
 * the existing mount-time takePendingFiles() → preset run → the combined
 * artifact proves BOTH effects (merged page count + page numbers).
 */

const FIX = 'tests/fixtures';

async function pdfjsLegacy() {
  const require = createRequire(import.meta.url);
  return require('pdfjs-dist/legacy/build/pdf.mjs') as typeof import('pdfjs-dist');
}

test('merge → chip → page-numbers: combined artifact carries both effects', async ({
  page,
}) => {
  await page.goto('./tools/merge');
  await page.setInputFiles('input[type="file"]', [
    `${FIX}/fixture-small.pdf`, // 2 pages
    `${FIX}/fixture-pagenums.pdf`, // 5 pages
  ]);
  await expect(page.locator('[role="checkbox"]')).toHaveCount(7, { timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Gộp và tải xuống' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('merged.pdf');

  // Chip → picker: img-to-pdf EXCLUDED (PDF-rejecting intake); ocr is now a
  // FIRST-CLASS target (v0.8.1 phase 5: mount-take + acceptsPdf lifted the
  // v0.8.0 D2 exclusion).
  const chip = page.getByRole('button', { name: 'Tiếp tục với kết quả' });
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await chip.click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Nhận dạng chữ (OCR)' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Ảnh sang PDF' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Đánh số trang' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Đánh số trang' }).click();
  await page.waitForURL('**/tools/page-numbers');
  // Auto-take loaded the 7-page merge through the standard validated intake.
  await expect(page.locator('[role="checkbox"]')).toHaveCount(7, { timeout: 30_000 });

  // Preset 3 run on the merged file.
  await page.locator('input[name="pagenums-preset"]').nth(2).check();
  const download2Promise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Đánh số và tải xuống' }).click();
  const download2 = await download2Promise;
  const path = (await download2.path())!;

  const legacy = await pdfjsLegacy();
  const task = legacy.getDocument({ data: new Uint8Array(readFileSync(path)) });
  const doc = await task.promise;
  try {
    expect(doc.numPages).toBe(7);
    const p1 = await (await doc.getPage(1)).getTextContent();
    expect(p1.items.map((i) => ('str' in i ? String(i.str) : '')).join(' ')).toContain('Trang 1/7');
    const p7 = await (await doc.getPage(7)).getTextContent();
    expect(p7.items.map((i) => ('str' in i ? String(i.str) : '')).join(' ')).toContain('Trang 7/7');
  } finally {
    await task.destroy();
  }
});

test('chip is absent after multi-output runs (split) and on reset states', async ({ page }) => {
  await page.goto('./tools/split');
  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-small.pdf`);
  await expect(page.getByText(/2 trang/).first()).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder('1-3,5,8-10').fill('1');
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Tách và tải xuống' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  await expect(page.getByRole('button', { name: 'Tiếp tục với kết quả' })).toHaveCount(0);
});
