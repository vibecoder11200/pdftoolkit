import { readFileSync } from 'node:fs';
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
// Track the built flavor, not a hardcoded version (bumps must not edit specs).
const PKG_VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version as string;

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
  await expect(page.getByTestId('footer-version')).toContainText(PKG_VERSION);
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

test('every tool page renders at its desktop root path; convert shows coming-soon', async ({
  page,
}) => {
  const tools = [
    'merge',
    'split',
    'extract',
    'remove',
    'reorder',
    'rotate',
    'fill-form',
    'ocr',
    'compress',
    'pdf-to-img',
    'img-to-pdf',
    'encrypt',
    'metadata',
    'sign',
  ];
  for (const tool of tools) {
    await page.goto(`./tools/${tool}`);
    // Dropzone inputs are permanently .hidden (clicks route through the
    // dropzone button) — attached-ness is the right landmark, not visibility.
    await expect(page.locator('input[type="file"]').first()).toBeAttached({
      timeout: 15_000,
    });
    // basename regression would leave #root empty — the nav proves render.
    await expect(page.locator('nav')).toBeVisible();
  }
  await page.goto('./tools/convert');
  await expect(page.locator('main')).toContainText(/đang phát triển|coming soon/i);
});

test('split multi-output: ONE dialog, parts written beside the pick', async ({ page }) => {
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console.error]', m.text());
  });
  await page.goto('./tools/split');
  await page.setInputFiles('input[type="file"]', 'tests/fixtures/fixture-small.pdf');
  await page.getByPlaceholder('1-3,5,8-10').fill('1,2');
  // The start guard silently no-ops until the async page-count probe lands —
  // wait for the hint that numPages is known before clicking.
  await page.getByText(/File có \d+ trang/).waitFor({ timeout: 30_000 });
  // default mode is 'separate' → deliverBytesMulti path
  await page.getByRole('button', { name: 'Tách và tải xuống' }).click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __desktopCalls: DesktopCall[] }).__desktopCalls.filter(
        (c) => c.cmd === 'plugin:fs|write_file',
      ).length >= 2,
    undefined,
    { timeout: 60_000 },
  );
  const calls = await readCalls(page);
  const dialogSaves = calls.filter((c) => c.cmd === 'plugin:dialog|save');
  expect(dialogSaves).toHaveLength(1); // one ask, not one per part
  const paths = calls
    .filter((c) => c.cmd === 'plugin:fs|write_file')
    .map((c) =>
      decodeURIComponent((c.options as { headers: { path: string } }).headers.path),
    );
  expect(paths).toEqual([
    // Contract: the FIRST part is written to the exact picked path (the user
    // may have renamed it in the dialog); siblings are derived beside it.
    PICKED,
    'C:\\Users\\tester\\Downloads\\fixture-small-part2.pdf',
  ]);
});

test('pdf-to-img: 2-page PDF saves one zip through the dialog (no browser download)', async ({
  page,
}) => {
  await page.goto('./tools/pdf-to-img');
  await page.setInputFiles('input[type="file"]', 'tests/fixtures/fixture-small.pdf');
  const cta = page.getByRole('button', { name: 'Xuất và tải xuống' });
  await expect(cta).toBeEnabled({ timeout: 30_000 });
  await cta.click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __desktopCalls: DesktopCall[] }).__desktopCalls.some(
        (c) => c.cmd === 'plugin:fs|write_file',
      ),
    undefined,
    { timeout: 90_000 },
  );
  const calls = await readCalls(page);
  const save = calls.find((c) => c.cmd === 'plugin:dialog|save');
  expect((save?.payload as { options: { defaultPath: string } }).options.defaultPath).toBe(
    'fixture-small-images.zip',
  );
  // The ZIP goes out as one artifact, not per-image files.
  expect(calls.filter((c) => c.cmd === 'plugin:fs|write_file')).toHaveLength(1);
});

test('service worker never registers in desktop mode (isTauri gate)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Kéo PDF hoặc ảnh vào đây' }).waitFor();
  await page.waitForTimeout(2500); // web flavor registers within ~1s when ungated
  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'absent';
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? 'registered' : 'none';
  });
  expect(sw).toBe('none');
});
