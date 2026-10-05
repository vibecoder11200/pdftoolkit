import { expect, test } from '@playwright/test';

test('home renders 12 tool cards with VI copy', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'file không rời khỏi máy bạn',
  );
  const cards = page.locator('.tool-card, a[data-cat]');
  await expect(cards).toHaveCount(12);
  await expect(page.getByText('Gộp PDF').first()).toBeVisible();
});

test('filter pills narrow the grid', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Sắp xếp trang' }).click();
  await expect(page.getByText('Gộp PDF').first()).toBeVisible();
  await expect(page.getByText('Ký tài liệu').first()).toBeHidden();
});

test('VI/EN toggle switches hero copy', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'EN' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'files never leave your device',
  );
  await page.getByRole('button', { name: 'VI' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'file không rời khỏi máy bạn',
  );
});

test('merge tool loads a PDF and renders lazy thumbnails', async ({ page }) => {
  await page.goto('./tools/merge');
  await page.setInputFiles('input[type="file"]', 'tests/fixtures/fixture-1mb.pdf');
  const thumbs = page.locator('img[src^="blob:"]');
  await expect(thumbs.first()).toBeVisible({ timeout: 30_000 });
  await expect(thumbs).toHaveCount(2); // fixture has 2 pages
  await expect(page.getByRole('heading', { name: 'Gộp PDF' })).toBeVisible();
});

test('digital self-sign downloads a signed PDF (browser bundle path)', async ({ page }) => {
  await page.goto('./tools/sign');
  await page.setInputFiles('input[type="file"]', 'tests/fixtures/fixture-1mb.pdf');
  await page.getByRole('heading', { name: 'Ký tài liệu' }).waitFor();
  // Digital toggle, then the mandatory acknowledgment it reveals.
  await page.locator('input[type="checkbox"]').first().check();
  await page.locator('input[type="checkbox"]').nth(1).check();
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Đặt ký và tải xuống' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/-signed\.pdf$/);
});
