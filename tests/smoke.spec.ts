import { expect, test, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { readFileSync } from 'node:fs';

// Dispatch a real window-level drop (home universal dropzone) with the given
// files constructed in-page — setInputFiles cannot reach window drop handlers.
// React commits the home tree (and attaches GlobalDrop's window listeners)
// asynchronously after load, so wait for the hero dropzone before dropping,
// otherwise the synthetic drop fires into the void.
async function dropOnWindow(
  page: Page,
  files: { name: string; mime: string; bytes: Uint8Array }[],
) {
  await page.getByRole('button', { name: 'Kéo PDF hoặc ảnh vào đây' }).waitFor({ state: 'visible' });
  await page.evaluate((payload) => {
    const dt = new DataTransfer();
    for (const f of payload) {
      dt.items.add(new File([f.bytes], f.name, { type: f.mime }));
    }
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);
}

const readFixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/${name}`));

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

test('dropping two PDFs suggests Merge and hands files off via checkPdfFile', async ({ page }) => {
  await page.goto('./');
  await dropOnWindow(page, [
    { name: 'a.pdf', mime: 'application/pdf', bytes: readFixture('fixture-1mb.pdf') },
    { name: 'b.pdf', mime: 'application/pdf', bytes: readFixture('fixture-1mb.pdf') },
    { name: 'fake.pdf', mime: 'application/pdf', bytes: new TextEncoder().encode('not a pdf at all') },
  ]);
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  // The renamed non-PDF is rejected with its reason (magic bytes, not MIME).
  await expect(sheet.getByText('không phải PDF')).toBeVisible();
  await sheet.getByRole('button', { name: /Gộp PDF/ }).click();
  await expect(page).toHaveURL(/\/tools\/merge$/);
  const thumbs = page.locator('img[src^="blob:"]');
  await expect(thumbs.first()).toBeVisible({ timeout: 30_000 }); // both files loaded
});

test('dropping an image suggests Img→PDF and navigates to /tools/img-to-pdf', async ({ page }) => {
  await page.goto('./');
  await dropOnWindow(page, [
    { name: 'photo.png', mime: 'image/png', bytes: readFixture('fixture-photo.png') },
  ]);
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(sheet.getByRole('button', { name: /Ảnh sang PDF/ })).toBeVisible();
  await sheet.getByRole('button', { name: /Ảnh sang PDF/ }).click();
  await expect(page).toHaveURL(/\/tools\/img-to-pdf$/);
  await expect(page.getByText(/1 ảnh/)).toBeVisible({ timeout: 15_000 });
});

test('dropping a locked PDF suggests Decrypt and opens encrypt in decrypt mode', async ({ page }) => {
  await page.goto('./');
  await dropOnWindow(page, [
    { name: 'locked.pdf', mime: 'application/pdf', bytes: readFixture('fixture-locked.pdf') },
  ]);
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(sheet.getByText('File đang khóa mật khẩu')).toBeVisible();
  await sheet.getByRole('button', { name: /Mã hóa PDF/ }).click();
  await expect(page).toHaveURL(/\/tools\/encrypt$/);
  // Decrypt tab is active with the file already loaded.
  await expect(page.getByPlaceholder('Nhập mật khẩu của file')).toBeVisible({ timeout: 15_000 });
});

test('mobile hamburger opens, navigates, and restores focus', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await page.goto('./');
  const hamburger = page.getByRole('button', { name: 'Menu' });
  await hamburger.click();
  const panel = page.locator('#mobile-nav-panel');
  await expect(panel).toBeVisible();
  await expect(hamburger).toHaveAttribute('aria-expanded', 'true');
  // Esc closes and hands focus back to the toggle.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(hamburger).toBeFocused();
  // Navigating from the panel closes it and lands on the tool.
  await hamburger.click();
  await panel.getByRole('link', { name: 'GỘP PDF' }).click();
  await expect(page).toHaveURL(/\/tools\/merge$/);
  await expect(page.locator('#mobile-nav-panel')).toBeHidden();
});

test('axe: no serious/critical violations on home and merge', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Kéo PDF hoặc ảnh vào đây' }).waitFor();
  for (const path of ['/', './tools/merge']) {
    await page.goto(path);
    const results = await new AxeBuilder({ page }).analyze();
    const bad = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(bad, `${path}: ${bad.map((v) => v.id).join(', ')}`).toEqual([]);
  }
});
