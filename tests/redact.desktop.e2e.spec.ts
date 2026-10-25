import { expect, test, type Page } from '@playwright/test';
import { stubTauri, readCalls } from './helpers/tauri-mock';
import { buildRedactFixture, REDACT_SECRET } from './helpers/redact-fixture';

/*
 * Redact desktop e2e (v0.9.0 phase 3). Runs from dist-desktop at the root
 * with the REAL tauri bridge mock seam (never a bespoke __TAURI_INTERNALS__).
 * Delivery is asserted through the captured `plugin:dialog|save` +
 * `plugin:fs|write_file` invokes (watermark.desktop precedent): on desktop
 * every save is the native Save-As, never a browser download.
 */

const FIX_OUT = 'test-results/redact-desktop-fixture.pdf';
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

test('redact run → ONE native Save-As with -redacted.pdf + real bytes', async ({ page }) => {
  test.setTimeout(180_000);
  await buildRedactFixture(FIX_OUT);
  await arrange(page);
  await page.goto('./tools/editor');
  await page.setInputFiles('input[type="file"]', FIX_OUT);
  await expect(page.getByTestId('editor-overlay')).toBeVisible({ timeout: 30_000 });

  // Mark the secret header on page 1 (surgical; page 2 rides the burn tier).
  const box = (await page.getByTestId('editor-overlay').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.04, box.y + box.height * 0.03);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.062, { steps: 6 });
  await page.mouse.up();
  await page.locator('textarea').fill(REDACT_SECRET);
  await page.getByRole('button', { name: 'Xác nhận che đi' }).click();

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
  ).toBe('redact-desktop-fixture-redacted.pdf');
  const write = calls.find((c) => c.cmd === 'plugin:fs|write_file');
  expect(write).toBeTruthy();
  const data = (write!.payload as { contents?: unknown } | undefined)?.contents ?? write!.payload;
  expect((data as Uint8Array).byteLength).toBeGreaterThan(1000);
});
