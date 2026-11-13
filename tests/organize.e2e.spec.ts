import { expect, test } from '@playwright/test';

/*
 * Organize e2e (web, phase 4): intake -> tiles -> reorder/rotate/duplicate/
 * blank -> bookmark add/target -> single export (typed deliver). The
 * instance grid is keyed by stable ids; display position never doubles as
 * identity (the thumbnail-strip duplicate-page assumption fix).
 */

test('organize: reorder, rotate, duplicate, blank, bookmark, export', async ({ page }) => {
  await page.goto('./tools/organize');
  await page.setInputFiles('input[type="file"]', [
    'tests/fixtures/fixture-small.pdf',
    'tests/fixtures/fixture-pagenums.pdf',
  ]);
  await expect(page.getByTestId('organize-grid')).toBeVisible({ timeout: 30_000 });
  const tiles = page.locator('[role="option"]');
  await expect(tiles.first()).toBeVisible();
  const initial = await tiles.count();
  expect(initial).toBeGreaterThanOrEqual(4); // both sources joined

  // button reorder: move page 1 right, then verify the first tile swapped
  const firstTile = tiles.first();
  await firstTile.waitFor({ timeout: 10_000 });
  const beforeMove = await firstTile.textContent();
  await page.getByTestId('tile-right-1').click();
  const afterMove = await firstTile.textContent();
  expect(afterMove).not.toBe(beforeMove);
  // rotate first tile
  await tiles.first().click();
  await page.getByRole('button', { name: 'Xoay phải' }).click();
  await expect(tiles.first()).toContainText('90°');
  // duplicate first tile -> count +1
  await page.getByRole('button', { name: 'Nhân bản' }).click();
  await expect(tiles).toHaveCount(initial + 1);
  // insert blank -> count +1
  await page.getByRole('button', { name: 'Chèn trang trắng' }).click();
  await expect(tiles).toHaveCount(initial + 2);
  await expect(page.getByText('Trang trắng').first()).toBeVisible();

  // bookmark: add + target picker binds to first instance
  await page.getByTestId('bm-add').click();
  await expect(page.getByTestId('bookmarks-panel')).toContainText('Mục mới');
  const sel = page.locator('select[aria-label="Chọn trang đích"]').first();
  await sel.selectOption({ index: 1 });
  await expect(sel).not.toHaveValue('');

  // export -> single download
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByTestId('organize-export').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/da-to-chuc\.pdf$/);
});
