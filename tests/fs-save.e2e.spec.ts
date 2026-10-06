import { expect, test } from '@playwright/test';

// File System Access save-back (phase 4): the "Chọn nơi lưu" companion button
// is Chromium-only, so this spec stubs showSaveFilePicker in-page — the real
// picker cannot be driven headlessly (plan decision D5).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Record what the tool delivers: name + bytes, for assertions.
    (window as unknown as Record<string, unknown>).__savedFiles = [];
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async (opts: { suggestedName?: string }) => ({
        createWritable: async () => ({
          write: async (blob: Blob) => {
            const buf = new Uint8Array(await blob.arrayBuffer());
            (window as unknown as { __savedFiles: { name: string; bytes: Uint8Array }[] })
              .__savedFiles.push({ name: opts.suggestedName ?? '', bytes: buf });
          },
          close: async () => undefined,
        }),
      }),
    });
  });
});

test('merge shows the picker button on Chromium and saves through it', async ({ page }) => {
  await page.goto('./tools/merge');
  const pick = page.getByRole('button', { name: 'Chọn nơi lưu' });
  await expect(pick).toBeVisible();
  await expect(pick).toBeDisabled(); // nothing loaded yet
  await page.setInputFiles('input[type="file"]', [
    'tests/fixtures/fixture-1mb.pdf',
    'tests/fixtures/fixture-10mb.pdf',
  ]);
  await page.getByRole('button', { name: 'Gộp và tải xuống' }).waitFor();
  await expect(pick).toBeEnabled();
  await pick.click();
  await page.waitForFunction(
    () => (window as unknown as { __savedFiles: unknown[] }).__savedFiles.length > 0,
    undefined,
    { timeout: 60_000 },
  );
  const saved = await page.evaluate(
    () =>
      (window as unknown as { __savedFiles: { name: string; bytes: Uint8Array }[] }).__savedFiles[0],
  );
  expect(saved.name).toBe('merged.pdf');
  // A real merged PDF comes back, not an empty promise.
  expect(saved.bytes.length).toBeGreaterThan(1000);
});

test('the picker button is hidden when showSaveFilePicker is unavailable (Firefox/Safari)', async ({
  page,
  browserName,
}) => {
  await page.addInitScript(() => {
    // @ts-expect-error deleting a configurable injectable
    delete window.showSaveFilePicker;
  });
  await page.goto('./tools/merge');
  await page.getByRole('button', { name: 'Gộp và tải xuống' }).waitFor();
  await expect(page.getByRole('button', { name: 'Chọn nơi lưu' })).toHaveCount(0);
  void browserName;
});

test('cancelling the picker is not an error: merge stays idle, no banner', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        throw err;
      },
    });
  });
  await page.goto('./tools/merge');
  await page.setInputFiles('input[type="file"]', [
    'tests/fixtures/fixture-1mb.pdf',
    'tests/fixtures/fixture-10mb.pdf',
  ]);
  await page.getByRole('button', { name: 'Chọn nơi lưu' }).click();
  await page.waitForFunction(
    () => (window as unknown as { __savedFiles: unknown[] }).__savedFiles.length === 0,
  );
  // No error banner surfaces for a plain cancel.
  await expect(page.getByRole('alert')).toHaveCount(0);
});
