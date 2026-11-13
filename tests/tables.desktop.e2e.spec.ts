import { expect, test } from '@playwright/test';
import { readCalls, stubTauri } from './helpers/tauri-mock';

/*
 * Tables desktop e2e (phase 5): intake -> grid -> XLSX export rides the
 * phase-3 delivery contract under the desktop mock seam: ONE directory
 * pick (plugin:dialog|open) + the Rust session writer (save_session_begin
 * / save_session_write with the basename header / save_session_end). No
 * plugin:fs write ever fires — the rc-probe #2 invariant holds for tool #22.
 */

const PICK_DIR = 'C:\\Users\\tester\\Documents';

test('tables desktop: xlsx export through the session writer', async ({ page }) => {
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

  await page.goto('./tools/tables');
  await page.setInputFiles('input[type="file"]', ['tests/fixtures/fixture-p2w-invoice.pdf']);
  await expect(page.getByTestId('tables-sheet-0')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('grid-cell-0-0')).toHaveValue('Item', { timeout: 30_000 });

  await page.getByTestId('tables-export-xlsx').click();

  await expect
    .poll(async () => {
      const calls = await readCalls(page);
      return calls.filter((c) => c.cmd === 'plugin:dialog|open').length;
    }, { timeout: 60_000 })
    .toBe(1);
  const calls = await readCalls(page);
  const begin = calls.find((c) => c.cmd === 'save_session_begin');
  expect(begin?.payload).toMatchObject({ path: PICK_DIR });
  const writes = calls.filter((c) => c.cmd === 'save_session_write');
  expect(writes).toHaveLength(1);
  const name = decodeURIComponent(
    (writes[0]!.options as { headers: { name: string } }).headers.name,
  );
  expect(name).toMatch(/invoice\.xlsx$/);
  // Data-only workbook bytes; no path ever rides a write.
  expect(JSON.stringify(writes[0]!.payload ?? null)).not.toContain('C:');
  expect(calls.filter((c) => c.cmd === 'plugin:fs|write_file')).toHaveLength(0);
  expect(calls.at(-1)?.cmd).toBe('save_session_end');
});
