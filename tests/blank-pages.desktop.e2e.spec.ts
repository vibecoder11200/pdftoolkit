import { expect, test } from '@playwright/test';
import { readCalls, stubTauri } from './helpers/tauri-mock';

/*
 * Blank-pages desktop e2e (v0.11.0 phase 9, plan 261109-1101): removal
 * delivers through the native Save-As (deliverBytes' WebView2
 * interception — RED-TEAM C9 requires desktop coverage for BOTH v0.11.0
 * tools). Same seam as the compare desktop spec.
 */

const SAVE_PATH = 'C:' + String.fromCharCode(92).repeat(4) + 'Users' + String.fromCharCode(92).repeat(4) + 'tester' + String.fromCharCode(92).repeat(4) + 'Downloads' + String.fromCharCode(92).repeat(4) + 'fixture-blank-mixed-da-xoa-trang.pdf';

function writePathOf(call: { payload?: unknown; options?: unknown }): string {
  const raw = ((call.options as { headers?: { path?: string } } | undefined)?.headers?.path ?? '') as string;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

test('blank-pages removal → native Save-As with -da-xoa-trang.pdf', async ({ page }) => {
  test.setTimeout(180_000);
  await stubTauri(page);
  await page.addInitScript((path) => {
    const w = window as unknown as {
      __tauriSetHandler: (cmd: string, fn: (payload?: unknown) => unknown) => void;
    };
    w.__tauriSetHandler('plugin:dialog|save', () => path);
  }, SAVE_PATH);

  await page.goto('./tools/blank-pages');
  await page.locator('input[type="file"]').first().setInputFiles('tests/fixtures/fixture-blank-mixed.pdf');
  await expect(page.getByText('6 trang', { exact: false })).toBeVisible({ timeout: 30_000 });
  const cta = page.getByRole('button', { name: 'Phát hiện trang trắng' });
  await expect(cta).toBeEnabled({ timeout: 30_000 });
  await cta.click();
  await expect(page.getByText('2 trang trắng')).toBeVisible({ timeout: 60_000 });

  // Desktop deliverBytes intercepts to the native Save-As — NO download
  // event exists in desktop mode; the dialog+write calls ARE the delivery.
  await page.getByRole('button', { name: 'Xóa 2 trang đã chọn' }).click();

  await expect
    .poll(async () => {
      const calls = await readCalls(page);
      return calls.filter((c) => c.cmd === 'plugin:dialog|save').length;
    }, { timeout: 60_000 })
    .toBe(1);
  const calls = await readCalls(page);
  const save = calls.find((c) => c.cmd === 'plugin:dialog|save');
  expect(
    (save!.payload as { options?: { defaultPath?: string } }).options?.defaultPath,
  ).toBe('fixture-blank-mixed-da-xoa-trang.pdf');
  const writes = calls.filter((c) => c.cmd === 'plugin:fs|write_file');
  expect(writes).toHaveLength(1);
  expect(writePathOf(writes[0]!)).toBe(SAVE_PATH);
});
