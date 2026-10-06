import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';

/*
 * Cross-tool happy paths against the built bundle (preview server).
 * Each flow drives a real tool page end-to-end: upload → configure → download.
 * Passwords/outputs are deterministic; fixtures are gitignored and generated
 * by `node tests/fixtures/gen.mjs`.
 */

const FIXTURE = 'tests/fixtures/fixture-1mb.pdf';

async function loadFixture(page: Page, path: string) {
  await page.setInputFiles('input[type="file"]', path);
}

async function loadFixtureBuffer(page: Page, file: { name: string; bytes: Buffer }) {
  await page.setInputFiles('input[type="file"]', {
    name: file.name,
    mimeType: 'application/pdf',
    buffer: file.bytes,
  });
}

test('rotate: one click rotates and downloads rotated.pdf', async ({ page }) => {
  await page.goto('./tools/rotate');
  await loadFixture(page, FIXTURE);
  const cta = page.getByRole('button', { name: 'Xoay và tải xuống' });
  await expect(cta).toBeEnabled({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await cta.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('rotated.pdf');
});

test('extract: selecting page 1 yields extracted.pdf', async ({ page }) => {
  await page.goto('./tools/extract');
  await loadFixture(page, FIXTURE);
  const page1 = page.locator('[role="checkbox"]').first();
  await expect(page1).toBeVisible({ timeout: 30_000 });
  await page1.click();
  await expect(page1).toHaveAttribute('aria-checked', 'true');
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Trích xuất và tải xuống' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('extracted.pdf');
});

test('split: range 1-1 in separate mode produces exactly one file', async ({ page }) => {
  await page.goto('./tools/split');
  await loadFixture(page, FIXTURE);
  const ranges = page.getByPlaceholder('1-3,5,8-10');
  await expect(ranges).toBeVisible({ timeout: 30_000 });
  // The run gate needs numPages > 0 — wait for the parsed-page meta, not just
  // the input (clicking during loadPdf reads as err_unreadable, no download).
  await expect(page.getByText(/2 trang/).first()).toBeVisible({ timeout: 30_000 });
  await ranges.fill('1-1');
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Tách và tải xuống' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/-part1\.pdf$/);
});

test('compress: vector pack output is not larger than the input', async ({ page }) => {
  await page.goto('./tools/compress');
  await loadFixture(page, FIXTURE);
  const cta = page.getByRole('button', { name: 'Nén và so sánh' });
  await expect(cta).toBeEnabled({ timeout: 30_000 });
  await cta.click();
  const dl = page.getByRole('button', { name: 'Tải xuống file đã nén' });
  await expect(dl).toBeVisible({ timeout: 60_000 });
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await dl.click();
  const download = await downloadPromise;
  const outSize = (await stat(await download.path())).size;
  const inSize = (await stat(FIXTURE)).size;
  expect(outSize).toBeLessThanOrEqual(inSize);
});

test('encrypt then decrypt round-trips back to a parsable PDF', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('./tools/encrypt');
  await loadFixture(page, FIXTURE);
  const pass = 'e2e-roundtrip-123';
  await page.getByPlaceholder('Nhập mật khẩu mở file').fill(pass);
  const encPromise = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Mã hóa và tải xuống' }).click();
  const enc = await encPromise;
  expect(enc.suggestedFilename()).toBe('fixture-1mb-encrypted.pdf');

  // Re-upload the encrypted output (named, not the browser temp GUID);
  // decrypt with the same password.
  await page.goto('./tools/encrypt');
  await loadFixtureBuffer(page, {
    name: enc.suggestedFilename(),
    bytes: readFileSync(await enc.path()),
  });
  const decPass = page.getByPlaceholder('Nhập mật khẩu của file');
  if (!(await decPass.isVisible())) {
    await page.getByRole('tab', { name: 'Giải mã' }).click();
  }
  await decPass.fill(pass);
  const decPromise = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Giải mã và tải xuống' }).click();
  const dec = await decPromise;
  expect(dec.suggestedFilename()).toBe('fixture-1mb-encrypted-decrypted.pdf');
  const bytes = readFileSync(await dec.path());
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(0);
});
