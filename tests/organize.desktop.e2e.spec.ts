import { expect, test } from '@playwright/test';
import { readCalls, stubTauri } from './helpers/tauri-mock';

/*
 * Organize desktop e2e (phase 4): same flow under the desktop mock seam.
 * Single-output export rides the native Save-As (plugin:dialog|save +
 * plugin:fs|write_file) — the rc-probe #2 invariant holds for the new tool.
 */

test('organize desktop: full flow exports through the native save', async ({ page }) => {
  await stubTauri(page);
  await page.addInitScript((path) => {
    const w = window as unknown as {
      __tauriSetHandler: (cmd: string, fn: (payload?: unknown) => unknown) => void;
    };
    w.__tauriSetHandler('plugin:dialog|save', () => path);
  }, 'C:\Users\tester\Documents\organized.pdf');

  await page.goto('./tools/organize');
  await page.setInputFiles('input[type="file"]', [
    'tests/fixtures/fixture-small.pdf',
    'tests/fixtures/fixture-pagenums.pdf',
  ]);
  const tiles = page.locator('[role="option"]');
  await expect(tiles.first()).toBeVisible({ timeout: 30_000 });
  await tiles.first().click();
  await page.getByRole('button', { name: 'Xoay phải' }).click();
  await expect(tiles.first()).toContainText('90°');

  const [save] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10_000 }).catch(() => null),
    page.getByTestId('organize-export').click(),
  ]);
  void save;
  await expect
    .poll(async () => {
      const calls = await readCalls(page);
      return calls.filter((c) => c.cmd === 'plugin:fs|write_file').length;
    }, { timeout: 60_000 })
    .toBe(1);
  const calls = await readCalls(page);
  const write = calls.find((c) => c.cmd === 'plugin:fs|write_file');
  expect(write).toBeTruthy();
  const path = decodeURIComponent(
    (write!.options as { headers: { path: string } }).headers.path,
  );
  expect(path).toBe('C:\Users\tester\Documents\organized.pdf');
});
