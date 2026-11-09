import { expect, test } from '@playwright/test';
import { readCalls, stubTauri } from './helpers/tauri-mock';

/*
 * Compare desktop e2e (v0.11.0 phase 8a, plan 261109-1101): the annotated
 * export goes through deliverBytesMulti's desktop path — ONE native Save-As
 * dialog (first filename as defaultPath) and BOTH PDFs written beside it
 * via plugin-fs (the rc-probe #2 invariant: WebView2 <a download> drops
 * files silently; every tool deliver MUST ride deliverBytes*).
 */

const SAVE_PATH = 'C:\\\\Users\\\\tester\\\\Downloads\\\\fixture-compare-a-so-sanh-A.pdf';

/** plugin-fs passes the target path through the invoke OPTIONS (percent-
 * encoded by the fs scope check) — same extraction as the watermark/
 * desktop-shell oracles, decoded here for readable assertions. */
function writePathOf(call: { payload?: unknown; options?: unknown }): string {
  const raw = ((call.options as { headers?: { path?: string } } | undefined)?.headers?.path ?? '') as string;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function payloadSizeOf(call: { payload?: unknown }): number {
  const data = (call.payload as { contents?: unknown } | undefined)?.contents ?? call.payload;
  if (data instanceof Uint8Array) return data.byteLength;
  if (typeof data === 'string') return data.length;
  if (Array.isArray(data)) return data.length;
  return 0;
}

test('compare export → ONE Save-As dialog, two PDFs written beside', async ({ page }) => {
  test.setTimeout(180_000);
  await stubTauri(page);
  await page.addInitScript((path) => {
    const w = window as unknown as {
      __tauriSetHandler: (cmd: string, fn: (payload?: unknown) => unknown) => void;
    };
    w.__tauriSetHandler('plugin:dialog|save', () => path);
  }, SAVE_PATH);

  await page.goto('./tools/compare');
  await page.locator('input[type="file"]').first().setInputFiles('tests/fixtures/fixture-compare-a.pdf');
  await page.locator('input[type="file"]').first().setInputFiles('tests/fixtures/fixture-compare-b.pdf');
  await expect(page.getByText('↔ fixture-compare-b.pdf · 2/3 trang')).toBeVisible({ timeout: 30_000 });
  const cta = page.getByRole('button', { name: 'So sánh ngay' });
  await expect(cta).toBeEnabled({ timeout: 30_000 });
  await cta.click();
  await expect(page.getByTestId('compare-result')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Xuất hai PDF chú giải' }).click();

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
  ).toBe('fixture-compare-a-so-sanh-A.pdf');
  const writes = calls.filter((c) => c.cmd === 'plugin:fs|write_file');
  console.log('DBGWRITE', JSON.stringify(calls.filter((c) => c.cmd.startsWith('plugin:fs')).map((c) => ({ o: c.options, pKeys: Object.keys((c.payload ?? {}) as object) })), null, 1));
  // A beside the picked path + B as its sibling.
  expect(writes).toHaveLength(2);
  expect(writePathOf(writes[0]!)).toBe(SAVE_PATH);
  expect(writePathOf(writes[1]!)).toBe(
    'C:\\\\Users\\\\tester\\\\Downloads\\\\fixture-compare-b-so-sanh-B.pdf',
  );
  for (const w of writes) {
    expect(payloadSizeOf(w)).toBeGreaterThan(1000);
  }
});
