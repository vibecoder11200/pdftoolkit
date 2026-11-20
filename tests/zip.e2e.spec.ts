import { expect, test, type Page } from '@playwright/test';

/*
 * v0.13.0 phase 2 (web): the split tool's opt-in .zip toggle produces
 * EXACTLY ONE download (a .zip), while the default path still produces the
 * per-part downloads (regression guard for the untouched multi contract).
 * Runs against the web dist under /pdftoolkit/.
 */

const FIXTURE = 'tests/fixtures/fixture-small.pdf';

async function loadFixture(page: Page, path: string) {
  await page.setInputFiles('input[type="file"]', path);
}

test('split: zip toggle collapses N parts into exactly one .zip download', async ({ page }) => {
  await page.goto('./tools/split');
  await loadFixture(page, FIXTURE);
  const ranges = page.getByPlaceholder('1-3,5,8-10');
  await expect(ranges).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/2 trang/).first()).toBeVisible({ timeout: 30_000 });
  await ranges.fill('1,2');
  const toggle = page.getByTestId('zip-toggle');
  await expect(toggle).toBeVisible(); // 2 parts → toggle present
  await toggle.locator('input[type="checkbox"]').check();
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await page.getByRole('button', { name: 'Tách và tải xuống' }).click();
  await expect(downloadWait(page)).resolves.toBeDefined();
  await page.waitForTimeout(1500); // the multi path spaces downloads 150ms — let stragglers appear
  expect(downloads).toHaveLength(1);
  expect(downloads[0]).toMatch(/-tap-hop\.zip$/);
});

test('split: default (no zip) still downloads per-part files', async ({ page }) => {
  await page.goto('./tools/split');
  await loadFixture(page, FIXTURE);
  const ranges = page.getByPlaceholder('1-3,5,8-10');
  await expect(ranges).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/2 trang/).first()).toBeVisible({ timeout: 30_000 });
  await ranges.fill('1-1');
  // 1 part → NO toggle (dead-UI rule), default path unaffected.
  await expect(page.getByTestId('zip-toggle')).toHaveCount(0);
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Tách và tải xuống' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/-part1\.pdf$/);
});

function downloadWait(page: Page): Promise<unknown> {
  return page.waitForEvent('download', { timeout: 60_000 });
}

test('compare: zip toggle collapses the annotated pair into one .zip download', async ({ page }) => {
  test.setTimeout(120_000);
  const fixA = 'tests/fixtures/fixture-compare-a.pdf';
  const fixB = 'tests/fixtures/fixture-compare-b.pdf';
  await page.goto('./tools/compare');
  await page.locator('input[type="file"]').first().setInputFiles(fixA);
  await page.locator('input[type="file"]').first().setInputFiles(fixB);
  await expect(page.getByText('↔ fixture-compare-b.pdf · 2/3 trang')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'So sánh ngay' }).click();
  await expect(page.getByTestId('compare-result')).toBeVisible({ timeout: 60_000 });
  const toggle = page.getByTestId('zip-toggle');
  await expect(toggle).toBeVisible();
  await toggle.locator('input[type="checkbox"]').check();
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await page.getByRole('button', { name: 'Xuất hai PDF chú giải' }).click();
  await expect.poll(async () => downloads.length, { timeout: 60_000 }).toBe(1);
  expect(downloads[0]).toMatch(/-tap-hop\.zip$/);
});
