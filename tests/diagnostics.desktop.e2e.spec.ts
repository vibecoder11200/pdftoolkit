import { expect, test } from '@playwright/test';
import { readCalls, stubTauri } from './helpers/tauri-mock';

/*
 * Phase-8 diagnostics desktop golden: healthy repair delivers through the
 * phase-3 desktop contract — ONE directory pick + the Rust session writer,
 * zero plugin:fs writes. (The unrecoverable-refusal leg is pinned by the
 * web spec; the refusal path never reaches delivery.)
 */

test('diagnostics desktop: repair -> one directory pick, session-writer delivery', async ({ page }) => {
  test.setTimeout(180_000);
  await stubTauri(page);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __tauriSetHandler: (cmd: string, fn: (payload?: unknown) => unknown) => void;
    };
    w.__tauriSetHandler('plugin:dialog|open', () => 'C:' + String.fromCharCode(92) + 'out');
    w.__tauriSetHandler('save_session_begin', () => ({ token: 'tok' }));
    w.__tauriSetHandler('save_session_write', (_payload: unknown, options?: unknown) => {
      const name = decodeURIComponent(
        (options as { headers?: { name?: string } } | undefined)?.headers?.name ?? '',
      );
      return { ok: true, path: 'C:' + String.fromCharCode(92) + 'out' + String.fromCharCode(92) + name };
    });
    w.__tauriSetHandler('save_session_end', () => null);
  });

  await page.goto('./tools/diagnostics');
  await page.locator('input[type="file"]').first().setInputFiles('tests/fixtures/fixture-small.pdf');
  await page.getByTestId('diag-run').click();
  await expect(page.getByTestId('diag-readable')).toContainText('có', { timeout: 60_000 });
  await page.getByTestId('diag-repair').click();

  await expect
    .poll(async () => {
      const calls = await readCalls(page);
      return calls.filter((c) => c.cmd === 'save_session_end').length;
    }, { timeout: 60_000 })
    .toBe(1);

  const calls = await readCalls(page);
  expect(calls.filter((c) => c.cmd === 'plugin:dialog|open').length).toBe(1);
  expect(calls.filter((c) => c.cmd.startsWith('plugin:fs|')).length).toBe(0);
  const writes = calls.filter((c) => c.cmd === 'save_session_write');
  expect(writes.length).toBe(1);
});
