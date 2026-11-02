import { expect, test } from '@playwright/test';
import { stubTauri, readCalls } from './helpers/tauri-mock';

/*
 * Desktop oracle for PDF → Word (v0.10.0 phase 5): on desktop every save is
 * the native Save-As (deliverBytes interception) — asserted through the
 * captured plugin:dialog|save + plugin:fs|write_file invokes (the
 * watermark.desktop pattern; the rc-probe regression guard).
 */

const FIX = 'tests/fixtures';
const SAVE_PATH = 'C:\\Users\\tester\\Downloads\\out.docx';

test('digital invoice → ONE native Save-As with the .docx name and real bytes', async ({
  page,
}) => {
  await stubTauri(page);
  await page.addInitScript((path) => {
    const w = window as unknown as {
      __tauriSetHandler: (cmd: string, fn: (payload?: unknown) => unknown) => void;
    };
    w.__tauriSetHandler('plugin:dialog|save', () => path);
  }, SAVE_PATH);

  await page.goto('./tools/pdf-to-word');
  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-p2w-invoice.pdf`);
  await expect(page.locator('input[name="p2w-mode"][value="digital"]')).toBeChecked({
    timeout: 30_000,
  });

  await page.getByRole('button', { name: 'Chuyển sang Word (.docx)' }).click();

  await expect
    .poll(async () => (await readCalls(page)).filter((c) => c.cmd === 'plugin:dialog|save').length, {
      timeout: 60_000,
    })
    .toBe(1);
  const writes = (await readCalls(page)).filter((c) => c.cmd === 'plugin:fs|write_file');
  expect(writes.length).toBeGreaterThanOrEqual(1);
  const write = writes[writes.length - 1]!;
  const data = (write.payload as { contents?: unknown } | undefined)?.contents ?? write.payload;
  const size = data instanceof Uint8Array ? data.byteLength : 0;
  expect(size).toBeGreaterThan(1000); // a real DOCX zip, not an empty stub
  expect((data as Uint8Array)[0]).toBe(0x50); // 'PK'
  expect((data as Uint8Array)[1]).toBe(0x4b); // 'K'
});
