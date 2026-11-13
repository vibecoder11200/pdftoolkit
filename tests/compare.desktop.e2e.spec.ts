import { expect, test } from '@playwright/test';
import { readCalls, stubTauri } from './helpers/tauri-mock';

/*
 * Compare desktop e2e (phase 3 delivery contract): the annotated export
 * goes through deliverBytesMulti's desktop path — ONE native DIRECTORY
 * pick (plugin:dialog|open) + the Rust session writer (save_session_begin
 * / per-file save_session_write with the basename in a header / end). The
 * rc-probe #2 invariant still holds: every tool deliver rides the typed
 * deliver path, never a silent <a download>.
 */

const PICK_DIR = 'C:\\\\Users\\\\tester\\\\Documents\\\\compare-out';

function payloadSizeOf(call: { payload?: unknown }): number {
  const data = (call.payload as { contents?: unknown } | undefined)?.contents ?? call.payload;
  if (data instanceof Uint8Array) return data.byteLength;
  if (typeof data === 'string') return data.length;
  if (Array.isArray(data)) return data.length;
  return 0;
}

test('compare export → ONE directory pick, session-writer writes (typed report)', async ({ page }) => {
  test.setTimeout(180_000);
  await stubTauri(page);
  await page.addInitScript((dir) => {
    const w = window as unknown as {
      __tauriSetHandler: (cmd: string, fn: (payload?: unknown) => unknown) => void;
    };
    w.__tauriSetHandler('plugin:dialog|open', () => dir);
    w.__tauriSetHandler('save_session_begin', () => ({ token: 'tok' }));
    w.__tauriSetHandler('save_session_write', (_payload: unknown, options?: unknown) => {
      const name = decodeURIComponent(
        (options as { headers?: { name?: string } } | undefined)?.headers?.name ?? '',
      );
      return { ok: true, path: `${dir}` + String.fromCharCode(92) + name };
    });
    w.__tauriSetHandler('save_session_end', () => null);
  }, PICK_DIR);

  await page.goto('./tools/compare');
  await page.locator('input[type="file"]').first().setInputFiles('tests/fixtures/fixture-compare-a.pdf');
  // A's async file validation must commit before its input unmounts and B
  // becomes the first input; otherwise a second change can hit A again.
  await expect(page.getByText('fixture-compare-a.pdf', { exact: true })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(1);
  await page.locator('input[type="file"]').setInputFiles('tests/fixtures/fixture-compare-b.pdf');
  await expect(page.getByText('↔ fixture-compare-b.pdf · 2/3 trang')).toBeVisible({ timeout: 30_000 });
  const cta = page.getByRole('button', { name: 'So sánh ngay' });
  await expect(cta).toBeEnabled({ timeout: 30_000 });
  await cta.click();
  await expect(page.getByTestId('compare-result')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Xuất hai PDF chú giải' }).click();

  await expect
    .poll(async () => {
      const calls = await readCalls(page);
      return calls.filter((c) => c.cmd === 'plugin:dialog|open').length;
    }, { timeout: 60_000 })
    .toBe(1);
  const calls = await readCalls(page);
  // ONE directory pick, then the session-writer protocol: begin → per-file
  // writes (basename header + raw bytes) → end.
  const begin = calls.find((c) => c.cmd === 'save_session_begin');
  expect(begin?.payload).toMatchObject({ path: PICK_DIR });
  const writes = calls.filter((c) => c.cmd === 'save_session_write');
  expect(writes).toHaveLength(2);
  const names = writes.map((w) =>
    decodeURIComponent((w.options as { headers: { name: string } }).headers.name),
  );
  expect(names[0]).toMatch(/fixture-compare-a-so-sanh-A\.pdf$/);
  expect(names[1]).toMatch(/fixture-compare-b-so-sanh-B\.pdf$/);
  // The raw byte body carries the real PDF; no path ever rides a write.
  for (const w of writes) {
    expect(payloadSizeOf(w)).toBeGreaterThan(1000);
    expect(JSON.stringify(w.payload ?? null)).not.toContain('C:');
  }
  expect(calls.filter((c) => c.cmd === 'plugin:fs|write_file')).toHaveLength(0);
  expect(calls.at(-1)?.cmd).toBe('save_session_end');
});
