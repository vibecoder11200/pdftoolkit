import { expect, test, type Page } from '@playwright/test';

/*
 * DESKTOP shell e2e (rc probe follow-up): the app as the Tauri window sees
 * it — served at the ROOT (base '/'), with `__TAURI_INTERNALS__` faked so
 * isTauri() is true and the real plugin guest code (dialog/fs/intake)
 * runs against a scripted invoke. This is the seam the real host uses,
 * so the real adapter code paths are exercised, not a re-implementation.
 *
 * Covers the two rc-probe findings:
 * - router basename: the app must render at '/' and at deep links;
 * - save flow: every deliver goes through the NATIVE save dialog
 *   (plugin:dialog|save) + plugin:fs|write_file — never the silent
 *   WebView2 <a download> that drops files with no chooser.
 */

type DesktopCall = { cmd: string; payload?: unknown; options?: unknown };

const PICKED = 'C:\\Users\\tester\\Downloads\\merged.pdf';

async function readCalls(page: Page): Promise<DesktopCall[]> {
  return page.evaluate(() => (window as unknown as { __desktopCalls: DesktopCall[] }).__desktopCalls);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const calls: { cmd: string; payload?: unknown; options?: unknown }[] = [];
    (window as unknown as { __desktopCalls: unknown }).__desktopCalls = calls;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, payload?: unknown, options?: unknown) => {
        calls.push({ cmd, payload, options });
        if (cmd === 'plugin:dialog|save')
          return Promise.resolve('C:\\Users\\tester\\Downloads\\merged.pdf');
        if (cmd === 'initial_open_files') return Promise.resolve([]);
        if (cmd === 'plugin:event|listen') return Promise.resolve(1);
        return Promise.resolve(null);
      },
      transformCallback: () => 1,
      convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}`,
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { windowLabel: 'main', label: 'main' },
      },
    };
  });
});

test('home renders at / with desktop intake active (basename follows desktop root)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Kéo PDF hoặc ảnh vào đây' }).waitFor();
  await expect(page.getByTestId('footer-version')).toContainText('0.3.9-rc');
  const cmds = (await readCalls(page)).map((c) => c.cmd);
  expect(cmds).toContain('initial_open_files');
});

test('deep link /tools/ocr renders (no basename blank-window regression)', async ({ page }) => {
  await page.goto('./tools/ocr');
  await expect(page.getByRole('button', { name: 'Thả file PDF cần OCR vào đây' })).toBeVisible();
});

test('merge: FSA toggle hidden, save goes through the native dialog + fs write', async ({
  page,
}) => {
  await page.goto('./tools/merge');
  // The File System Access affordance is web-only — on desktop every save
  // must open the native dialog instead.
  await expect(page.getByRole('button', { name: 'Chọn nơi lưu' })).toHaveCount(0);
  await page.setInputFiles('input[type="file"]', [
    'tests/fixtures/fixture-small.pdf',
    'tests/fixtures/fixture-medium.pdf',
  ]);
  await page.getByRole('button', { name: 'Gộp và tải xuống' }).click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __desktopCalls: DesktopCall[] }).__desktopCalls.some(
        (c) => c.cmd === 'plugin:fs|write_file',
      ),
    undefined,
    { timeout: 60_000 },
  );
  const calls = await readCalls(page);
  // dialog guest: invoke(cmd, { options }); fs guest: invoke(cmd, data,
  // { headers: { path } }) — raw-bytes IPC, path rides in a header.
  const save = calls.find((c) => c.cmd === 'plugin:dialog|save');
  expect((save?.payload as { options: { defaultPath: string } }).options.defaultPath).toBe(
    'merged.pdf',
  );
  const write = calls.find((c) => c.cmd === 'plugin:fs|write_file');
  expect(
    decodeURIComponent(
      (write?.options as { headers: { path: string } }).headers.path,
    ),
  ).toBe(PICKED);
  const data = write?.payload as ArrayBuffer | Uint8Array | number[] | undefined;
  const size =
    data instanceof ArrayBuffer
      ? data.byteLength
      : typeof data === 'object' && data !== null
        ? (data as Uint8Array).byteLength ?? (data as number[]).length
        : 0;
  expect(size).toBeGreaterThan(1000); // a real merged PDF, not an empty stub
});
