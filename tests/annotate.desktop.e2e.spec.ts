import { expect, test, type Page } from '@playwright/test';
import { stubTauri, readCalls } from './helpers/tauri-mock';
import { buildAnnotateFixture } from './helpers/annotate-fixture';

/*
 * Annotate desktop e2e (v0.9.0 phase 4): the REAL tauri bridge mock seam —
 * delivery is ONE native Save-As with -annotated.pdf + real bytes.
 */

const FIX_OUT = 'test-results/annotate-desktop-fixture.pdf';
const SAVE_PATH = 'C:\Users\tester\Downloads\out.pdf';

async function arrange(page: Page): Promise<void> {
  await stubTauri(page);
  await page.addInitScript((path) => {
    const w = window as unknown as {
      __tauriSetHandler: (cmd: string, fn: (payload?: unknown) => unknown) => void;
    };
    w.__tauriSetHandler('plugin:dialog|save', () => path);
  }, SAVE_PATH);
}

test('annotate run → ONE native Save-As with -annotated.pdf + real bytes', async ({ page }) => {
  test.setTimeout(180_000);
  await buildAnnotateFixture(FIX_OUT);
  await arrange(page);
  await page.goto('./tools/editor');
  await page.setInputFiles('input[type="file"]', FIX_OUT);
  await expect(page.getByTestId('editor-overlay')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Ghi chú' }).click();
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas');
      return !!c && c.width > 100 && c.height > 100;
    },
    undefined,
    { timeout: 30_000 },
  );
  const box = (await page.getByTestId('annotate-overlay').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.08, box.y + box.height * 0.08);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.16, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Áp dụng và tải xuống' }).click();

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
  ).toBe('annotate-desktop-fixture-annotated.pdf');
  const write = calls.find((c) => c.cmd === 'plugin:fs|write_file');
  expect(write).toBeTruthy();
  const data = (write!.payload as { contents?: unknown } | undefined)?.contents ?? write!.payload;
  expect((data as Uint8Array).byteLength).toBeGreaterThan(1000);
});

test('annotate M2: highlight+note apply intercepts to the SAME single native Save-As', async ({ page }) => {
  test.setTimeout(180_000);
  await buildAnnotateFixture(FIX_OUT);
  await arrange(page);
  await page.goto('./tools/editor');
  await page.setInputFiles('input[type="file"]', FIX_OUT);
  await expect(page.getByTestId('editor-overlay')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Ghi chú' }).click();
  await page.getByRole('button', { name: 'Đánh dấu sáng' }).click();
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas');
      return !!c && c.width > 100 && c.height > 100;
    },
    undefined,
    { timeout: 30_000 },
  );
  const overlay = page.getByTestId('annotate-overlay');
  const box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.07);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.12, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Ghi chú', exact: true }).click();
  await page.getByLabel('Nội dung ghi chú').fill('NOTE-77');
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.4, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Áp dụng và tải xuống' }).click();

  await expect
    .poll(async () => {
      const calls = await readCalls(page);
      return calls.filter((c) => c.cmd === 'plugin:dialog|save').length;
    }, { timeout: 60_000 })
    .toBe(1); // mixed stamps/annots still deliver through ONE Save-As
  const calls = await readCalls(page);
  const write = calls.find((c) => c.cmd === 'plugin:fs|write_file');
  expect(write).toBeTruthy();
  const data = (write!.payload as { contents?: unknown } | undefined)?.contents ?? write!.payload;
  expect((data as Uint8Array).byteLength).toBeGreaterThan(1000);
});
