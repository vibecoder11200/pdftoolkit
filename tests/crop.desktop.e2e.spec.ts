import { expect, test, type Page } from '@playwright/test';
import { stubTauri, readCalls } from './helpers/tauri-mock';
import { buildAnnotateFixture } from './helpers/annotate-fixture';

/*
 * Crop desktop e2e (v0.9.0 phase 7): crop delivers through ONE native
 * Save-As with -cropped.pdf + real bytes.
 */

const FIX_OUT = 'test-results/crop-desktop-fixture.pdf';
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

test('crop run → ONE native Save-As with -cropped.pdf + real bytes', async ({ page }) => {
  test.setTimeout(180_000);
  await buildAnnotateFixture(FIX_OUT);
  await arrange(page);
  await page.goto('./tools/editor');
  await page.setInputFiles('input[type="file"]', FIX_OUT);
  await expect(page.getByTestId('editor-overlay')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Cắt' }).click();
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas');
      return !!c && c.width > 100 && c.height > 100;
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(300);
  const overlay = page.getByTestId('crop-overlay');
  const box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.08);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId('crop-box')).toBeVisible();
  await page.getByRole('button', { name: 'Cắt', exact: true }).click();

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
  ).toBe('crop-desktop-fixture-cropped.pdf');
  const write = calls.find((c) => c.cmd === 'plugin:fs|write_file');
  expect(write).toBeTruthy();
  const data = (write!.payload as { contents?: unknown } | undefined)?.contents ?? write!.payload;
  expect((data as Uint8Array).byteLength).toBeGreaterThan(1000);
});
