import { expect, test } from '@playwright/test';

/*
 * Tables e2e (web, phase 5): intake a digital ruled-table PDF -> grid
 * renders detected cells -> inline cell edit -> CSV + XLSX exports ride
 * the phase-3 delivery contract (typed report; single downloads on web).
 */

test('tables: detect, edit, export csv + xlsx', async ({ page }) => {
  await page.goto('./tools/tables');
  await page.setInputFiles('input[type="file"]', ['tests/fixtures/fixture-p2w-invoice.pdf']);

  // sheet appears with the detected invoice table (header row = Item/Qty/...)
  await expect(page.getByTestId('tables-sheet-0')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('tables-sheet-0')).toContainText('5×4');
  const firstCell = page.getByTestId('grid-cell-0-0');
  await expect(firstCell).toHaveValue('Item', { timeout: 30_000 });

  // inline edit persists to the input value
  await firstCell.fill('Sản phẩm');
  await expect(firstCell).toHaveValue('Sản phẩm');

  // CSV export -> download
  const [csvDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByTestId('tables-export-csv').click(),
  ]);
  expect(csvDownload.suggestedFilename()).toMatch(/invoice\.csv$/);

  // XLSX export -> download
  const [xlsxDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByTestId('tables-export-xlsx').click(),
  ]);
  expect(xlsxDownload.suggestedFilename()).toMatch(/invoice\.xlsx$/);
});

test('tables: scan pages via ai-mock → review-required sheets', async ({ page }) => {
  await page.goto('./tools/tables?ai-mock=1');
  // blank-mixed: 3 prose pages (digital, no tables) + 3 low-text pages
  // (census → scan). AI mock returns markdown tables for them.
  await page.setInputFiles('input[type="file"]', ['tests/fixtures/fixture-blank-mixed.pdf']);
  await expect(page.getByTestId('tables-scan-arm')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('tables-scan-arm').click();
  await expect(page.getByTestId('tables-scan-run')).toBeVisible();
  await page.getByTestId('tables-scan-run').click();
  // scan sheets land as review-required (unverified until human confirm)
  await expect(page.getByTestId('tables-sheet-0')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('tables-sheet-0')).toContainText('quét');
  await expect(page.getByTestId('grid-review-badge').first()).toBeVisible({ timeout: 30_000 });
});
