import { expect, test, type Page } from '@playwright/test';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stubTauri, readCalls } from './helpers/tauri-mock';

/*
 * Desktop oracle for both v0.8.0 tools + folder batch + chaining (phase 5).
 * Runs from dist-desktop at the root with the REAL tauri bridge mock seam
 * (never a bespoke __TAURI_INTERNALS__ — AGENTS native-OCR invariant).
 * Delivery is asserted through the captured `plugin:dialog|save` +
 * `plugin:fs|write_file` invokes (ocr-sandwich desktop precedent): on
 * desktop every save is the native Save-As, never a browser download.
 */

const FIX = 'tests/fixtures';
const SAVE_PATH = 'C:\\Users\\tester\\Downloads\\out.pdf';

async function arrange(page: Page): Promise<void> {
  await stubTauri(page);
  await page.addInitScript((path) => {
    const w = window as unknown as {
      __tauriSetHandler: (cmd: string, fn: (payload?: unknown) => unknown) => void;
    };
    w.__tauriSetHandler('plugin:dialog|save', () => path);
  }, SAVE_PATH);
}

function writePathOf(call: { payload?: unknown; options?: unknown }): string {
  // plugin-fs passes the target path through the invoke options, percent-
  // encoded by the fs scope check (same extraction as desktop-shell's
  // merged-write oracle, decoded here for readable assertions).
  const raw = ((call.options as { headers?: { path?: string } } | undefined)?.headers?.path ?? '') as string;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function payloadSizeOf(call: { payload?: unknown }): number {
  const data = (call.payload as { contents?: unknown } | undefined)?.contents ?? call.payload;
  if (data instanceof Uint8Array) return data.byteLength;
  if (typeof data === 'string') return data.length;
  if (Array.isArray(data)) return data.length;
  return 0;
}

test('watermark single run → ONE native Save-As with -watermarked.pdf + real bytes', async ({
  page,
}) => {
  await arrange(page);
  await page.goto('./tools/watermark');
  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-small.pdf`);
  await expect(page.locator('[role="checkbox"]')).toHaveCount(2, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Đóng dấu và tải xuống' }).click();

  await expect
    .poll(async () => {
      const calls = await readCalls(page);
      return calls.filter((c) => c.cmd === 'plugin:dialog|save').length;
    }, { timeout: 20_000 })
    .toBe(1);
  const calls = await readCalls(page);
  const save = calls.find((c) => c.cmd === 'plugin:dialog|save');
  expect(
    (save!.payload as { options?: { defaultPath?: string } }).options?.defaultPath,
  ).toBe('fixture-small-watermarked.pdf');
  const write = calls.find((c) => c.cmd === 'plugin:fs|write_file');
  expect(writePathOf(write!)).toBe(SAVE_PATH);
  expect(payloadSizeOf(write!)).toBeGreaterThan(1000);
});

test('page-numbers preset run → native Save-As with -numbered.pdf', async ({ page }) => {
  await arrange(page);
  await page.goto('./tools/page-numbers');
  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-pagenums.pdf`);
  await expect(page.locator('[role="checkbox"]')).toHaveCount(5, { timeout: 30_000 });
  await page.locator('input[name="pagenums-preset"]').nth(2).check();
  await page.getByRole('button', { name: 'Đánh số và tải xuống' }).click();

  await expect
    .poll(async () => {
      const calls = await readCalls(page);
      return calls.filter((c) => c.cmd === 'plugin:dialog|save').length;
    }, { timeout: 20_000 })
    .toBe(1);
  const calls = await readCalls(page);
  const save = calls.find((c) => c.cmd === 'plugin:dialog|save');
  expect(
    (save!.payload as { options?: { defaultPath?: string } }).options?.defaultPath,
  ).toBe('fixture-pagenums-numbered.pdf');
  expect(calls.filter((c) => c.cmd === 'plugin:fs|write_file').length).toBe(1);
});

test('folder batch → ONE Save-As dialog, sibling writes, named X/Y report', async ({
  page,
}) => {
  const dir = join('test-results', 'watermark-batch-desktop');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(`${FIX}/fixture-small.pdf`, join(dir, 'a-small.pdf'));
  copyFileSync(`${FIX}/fixture-pagenums.pdf`, join(dir, 'b-pagenums.pdf'));
  copyFileSync(`${FIX}/fixture-locked.pdf`, join(dir, 'c-locked.pdf'));

  await arrange(page);
  await page.goto('./tools/watermark');
  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-small.pdf`);
  await expect(page.locator('[role="checkbox"]')).toHaveCount(2, { timeout: 30_000 });

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10_000 }),
    page.getByRole('button', { name: 'Đóng dấu cả thư mục' }).click(),
  ]);
  await chooser.setFiles(dir);

  // The named failure report (D3) names the locked file; both valid files
  // land as sibling writes next to the ONE picked path.
  await expect(page.getByText(/2\/3 thành công/)).toBeVisible({ timeout: 60_000 });
  expect(await page.getByText(/2\/3 thành công/).textContent()).toContain('c-locked.pdf');
  const calls = await readCalls(page);
  expect(calls.filter((c) => c.cmd === 'plugin:dialog|save').length).toBe(1);
  const writes = calls.filter((c) => c.cmd === 'plugin:fs|write_file');
  expect(writes.length).toBe(2);
  // First file at the picked path; the sibling lands beside it (folder cut
  // from the picked path + its own name — saveBytesDesktopMulti).
  expect(writePathOf(writes[0])).toBe(SAVE_PATH);
  expect(writePathOf(writes[1])).toBe('C:\\Users\\tester\\Downloads\\b-pagenums-watermarked.pdf');
  for (const w of writes) expect(payloadSizeOf(w)).toBeGreaterThan(1000);
  rmSync(dir, { recursive: true, force: true });
});

test('chaining leg: watermark → chip → page-numbers auto-takes under the mock', async ({
  page,
}) => {
  await arrange(page);
  await page.goto('./tools/watermark');
  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-small.pdf`);
  await expect(page.locator('[role="checkbox"]')).toHaveCount(2, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Đóng dấu và tải xuống' }).click();
  await expect
    .poll(async () => (await readCalls(page)).some((c) => c.cmd === 'plugin:dialog|save'), {
      timeout: 20_000,
    })
    .toBe(true);

  // The in-page File handoff (Blob snapshot → appendPendingFiles → navigate
  // → mount take) must behave identically under WebView2.
  const chip = page.getByRole('button', { name: 'Tiếp tục với kết quả' });
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await chip.click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Nhận dạng chữ (OCR)' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Đánh số trang' }).click();
  await page.waitForURL('**/tools/page-numbers');
  await expect(page.locator('[role="checkbox"]')).toHaveCount(2, { timeout: 30_000 });
});
