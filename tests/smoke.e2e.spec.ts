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

test('PWA file handler: launchQueue hands a PDF to the reactive sheet', async ({ page }) => {
  const bytes = Array.from(readFixture('fixture-1mb.pdf'));
  await page.addInitScript((payload) => {
    const file = new File([new Uint8Array(payload)], 'handled.pdf', { type: 'application/pdf' });
    Object.defineProperty(window, 'launchQueue', {
      value: {
        setConsumer: (cb: (p: { files: { getFile: () => Promise<File> }[] }) => void) =>
          cb({ files: [{ getFile: async () => file }] }),
      },
    });
  }, bytes);
  await page.goto('./');
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await sheet.getByRole('button', { name: /Gộp PDF/ }).click();
  await expect(page).toHaveURL(/\/tools\/merge$/);
  const thumbs = page.locator('img[src^="blob:"]');
  await expect(thumbs.first()).toBeVisible({ timeout: 30_000 });
});

test('launch while on a tool page: banner offers Home, action opens the sheet', async ({ page }) => {
  const bytes = Array.from(readFixture('fixture-1mb.pdf'));
  await page.addInitScript((payload) => {
    const file = new File([new Uint8Array(payload)], 'parked.pdf', { type: 'application/pdf' });
    // Deliver the launch only after the app has booted on the tool page.
    let consumer: ((p: { files: { getFile: () => Promise<File> }[] }) => void) | null = null;
    Object.defineProperty(window, 'launchQueue', {
      value: {
        setConsumer: (cb: (p: { files: { getFile: () => Promise<File> }[] }) => void) => {
          consumer = cb;
        },
      },
    });
    setTimeout(() => consumer?.({ files: [{ getFile: async () => file }] }), 1500);
  }, bytes);
  await page.goto('./tools/split');
  await expect(page.getByPlaceholder('1-3,5,8-10')).toBeVisible({ timeout: 30_000 });
  const banner = page.getByRole('status').filter({ hasText: 'Đã nhận 1 file' });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  // The P0 fix under test: parked files replay to the home sheet on arrival.
  await banner.getByRole('button', { name: 'Mở Home' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  // The sheet lists counts, not valid filenames — 1 parked file shows as "1 file".
  await expect(sheet.getByText(/^1 file ·/)).toBeVisible();
});

test('all-tools grid: a single-file tool explains itself instead of truncating', async ({ page }) => {
  await page.goto('./');
  // 1 valid PDF keeps the all-tools grid visible; the two fakes push the
  // dropped batch to 3 files — exactly the setup where a single-file tool
  // would have silently kept only the first.
  await dropOnWindow(page, [
    { name: 'a.pdf', mime: 'application/pdf', bytes: readFixture('fixture-1mb.pdf') },
    { name: 'fake1.pdf', mime: 'application/pdf', bytes: new TextEncoder().encode('not a pdf') },
    { name: 'fake2.pdf', mime: 'application/pdf', bytes: new TextEncoder().encode('not a pdf') },
  ]);
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await sheet.getByRole('button', { name: /^Tách PDF/ }).click();
  await expect(sheet.getByText('chỉ nhận 1 file')).toBeVisible();
  await expect(page).toHaveURL(/\/pdftoolkit\/?$/); // never navigated away
});

test('pdf-to-img on a 2-page PDF downloads one zip (not per-image files)', async ({ page }) => {
  await page.goto('./tools/pdf-to-img');
  await page.setInputFiles('input[type="file"]', 'tests/fixtures/fixture-1mb.pdf');
  const cta = page.getByRole('button', { name: 'Xuất và tải xuống' });
  await expect(cta).toBeEnabled({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download', { timeout: 90_000 });
  await cta.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('fixture-1mb-images.zip');
});

test('first-visit tour shows once and skip persists across reload', async ({ page }) => {
  // The tour hides from automation (navigator.webdriver); opt in explicitly.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { value: false, configurable: true });
  });
  await page.goto('./');
  const tourDialog = page.getByRole('dialog');
  await expect(tourDialog).toBeVisible({ timeout: 10_000 });
  await tourDialog.getByRole('button', { name: 'Bỏ qua' }).click();
  await expect(tourDialog).toBeHidden();
  await page.reload();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('offline reload is served entirely from the precache', async ({ page, context }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Kéo PDF hoặc ảnh vào đây' }).waitFor();
  await page.waitForFunction(
    async () => {
      if (!navigator.serviceWorker) return false;
      const reg = await navigator.serviceWorker.ready;
      return Boolean(reg.active);
    },
    undefined,
    { timeout: 20_000 },
  );
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByRole('button', { name: 'Kéo PDF hoặc ảnh vào đây' })).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await context.setOffline(false);
  }
});

test('footer chip shows the package version + 7-char commit hash; no update banner when nothing waits', async ({
  page,
}) => {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  await page.goto('./');
  const chip = page.getByTestId('footer-version');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText(new RegExp(`^v${version} \\u00b7 [0-9a-f]{7}$`));
  await expect(page.getByRole('status').filter({ hasText: 'phiên bản mới' })).toHaveCount(0);
  await expect(page.getByTestId('update-dot')).toHaveCount(0);
});

test('axe: no serious/critical violations on home, merge, and 4 swept tools', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Kéo PDF hoặc ảnh vào đây' }).waitFor();
  for (const path of [
    '/',
    './tools/merge',
    './tools/rotate',
    './tools/extract',
    './tools/split',
    './tools/compress',
  ]) {
    await page.goto(path);
    const results = await new AxeBuilder({ page }).analyze();
    const bad = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(bad, `${path}: ${bad.map((v) => v.id).join(', ')}`).toEqual([]);
  }
});
