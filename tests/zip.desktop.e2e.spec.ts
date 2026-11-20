import { expect, test, type Page } from '@playwright/test';
import { stubTauri, readCalls, type DesktopCall } from './helpers/tauri-mock';

/*
 * v0.13.0 phase 2 (desktop): the split tool's .zip toggle goes through the
 * SINGLE Save-As seam (plugin:dialog|save + plugin-fs write at the chosen
 * path); the session writer (save_session_begin/write/end) stays COMPLETELY
 * OUT of the zip path (0 invokes) and the written payload is a real ZIP
 * (PK magic). The loose default path still uses the session writer.
 */

const FIX = 'tests/fixtures';
const SAVE_PATH = 'C:\\Users\\tester\\Downloads\\out.zip';
const PICK_DIR = 'C:\\Users\\tester\\Documents\\split-out';

async function arrange(page: Page, opts: { openDir?: string } = {}): Promise<void> {
  await stubTauri(page);
  await page.addInitScript(
    ({ path, openDir }) => {
      const w = window as unknown as {
        __tauriSetHandler: (cmd: string, fn: (payload?: unknown) => unknown) => void;
      };
      w.__tauriSetHandler('plugin:dialog|save', () => path);
      // Directory pick: null by default (the zip path must never fire it);
      // the default-path test wires a real directory + the session writer.
      w.__tauriSetHandler('plugin:dialog|open', () => openDir);
      if (openDir) {
        w.__tauriSetHandler('save_session_begin', () => ({ token: 'tok' }));
        w.__tauriSetHandler('save_session_write', (_p: unknown, options?: unknown) => {
          const name = decodeURIComponent(
            (options as { headers?: { name?: string } } | undefined)?.headers?.name ?? '',
          );
          return { ok: true, path: openDir + String.fromCharCode(92) + name };
        });
        w.__tauriSetHandler('save_session_end', () => null);
      }
    },
    { path: SAVE_PATH, openDir: opts.openDir ?? null },
  );
}

function payloadOf(call: DesktopCall): Uint8Array | null {
  const data = (call.payload as { contents?: unknown } | undefined)?.contents ?? call.payload;
  return data instanceof Uint8Array ? data : null;
}

async function toggleZip(page: Page): Promise<void> {
  const ranges = page.getByPlaceholder('1-3,5,8-10');
  await expect(ranges).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/2 trang/).first()).toBeVisible({ timeout: 30_000 });
  await ranges.fill('1,2');
  const toggle = page.getByTestId('zip-toggle');
  await expect(toggle).toBeVisible();
  await toggle.locator('input[type="checkbox"]').check();
  await page.getByRole('button', { name: 'Tách và tải xuống' }).click();
}

test('split zip on desktop → ONE Save-As, session writer untouched, real PK zip bytes', async ({
  page,
}) => {
  await arrange(page);
  await page.goto('./tools/split');
  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-small.pdf`);
  await toggleZip(page);

  await expect
    .poll(async () => {
      const calls = await readCalls(page);
      return calls.filter((c) => c.cmd === 'plugin:dialog|save').length;
    }, { timeout: 30_000 })
    .toBe(1);
  const calls = await readCalls(page);
  const save = calls.find((c) => c.cmd === 'plugin:dialog|save');
  expect(
    (save!.payload as { options?: { defaultPath?: string } }).options?.defaultPath,
  ).toMatch(/-tap-hop\.zip$/);
  const writes = calls.filter((c) => c.cmd === 'plugin:fs|write_file');
  expect(writes).toHaveLength(1);
  const payload = payloadOf(writes[0]!);
  expect(payload).not.toBeNull();
  expect(Buffer.from(payload!).subarray(0, 2).toString('latin1')).toBe('PK');
  expect(calls.filter((c) => c.cmd.startsWith('save_session')).length).toBe(0);
  expect(calls.filter((c) => c.cmd === 'plugin:dialog|open').length).toBe(0);
});

test('split default (no zip) on desktop still uses ONE directory pick + session writes', async ({
  page,
}) => {
  await arrange(page, { openDir: PICK_DIR });
  await page.goto('./tools/split');
  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-small.pdf`);
  // Default separate path with 2 parts: 1 directory pick + 2 session writes.
  const ranges = page.getByPlaceholder('1-3,5,8-10');
  await expect(ranges).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/2 trang/).first()).toBeVisible({ timeout: 30_000 });
  await ranges.fill('1,2');
  await expect(page.getByTestId('zip-toggle')).toBeVisible(); // toggle visible, unchecked
  await page.getByRole('button', { name: 'Tách và tải xuống' }).click();

  await expect
    .poll(async () => {
      const calls = await readCalls(page);
      return calls.filter((c) => c.cmd === 'save_session_write').length;
    }, { timeout: 30_000 })
    .toBe(2);
  const calls = await readCalls(page);
  expect(calls.filter((c) => c.cmd === 'plugin:dialog|save').length).toBe(0);
  expect(calls.filter((c) => c.cmd === 'plugin:dialog|open').length).toBe(1);
});
