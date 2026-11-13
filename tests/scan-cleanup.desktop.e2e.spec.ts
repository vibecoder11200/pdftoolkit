import { expect, test } from '@playwright/test';
import { readCalls, stubTauri } from './helpers/tauri-mock';

/*
 * Scan-cleanup desktop e2e (phase 6): single-output export rides the
 * phase-3 delivery contract — ONE directory pick + the Rust session
 * writer (save_session_begin/write with basename header/end). No
 * plugin:fs write ever fires (rc-probe #2 invariant for tool #23).
 */

const PICK_DIR = 'C:\\Users\\tester\\Documents';

test('scan-cleanup desktop: cleaned pdf through the session writer', async ({ page }) => {
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

  await page.goto('./tools/scan-cleanup');
  await page.setInputFiles('input[type="file"]', ['tests/fixtures/fixture-scan-dirty.pdf']);
  await expect(page.getByTestId('cleanup-before-canvas')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const c = document.querySelector('[data-testid="cleanup-before-canvas"]') as HTMLCanvasElement | null;
      return !!c && c.width > 100;
    },
    { timeout: 30_000 },
  );

  await page.getByTestId('cleanup-export').click();

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
  expect(name).toMatch(/-da-ve-sinh\.pdf$/);
  expect(calls.filter((c) => c.cmd === 'plugin:fs|write_file')).toHaveLength(0);
  expect(calls.at(-1)?.cmd).toBe('save_session_end');
});
