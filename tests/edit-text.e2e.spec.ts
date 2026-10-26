import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAnnotateFixture } from './helpers/annotate-fixture';

/*
 * Edit-text e2e (v0.9.0 phase 6 — M3a): click a run on the positional
 * layer, type the replacement, apply, and prove with pdf.js that the
 * original line is GONE (run-scoped) while the replacement extracts as
 * real, searchable text — and the other page is untouched.
 */

const FIX_OUT = 'test-results/edit-e2e-fixture.pdf';
const TARGET = 'Page one body text.';
const REPLACEMENT = 'EDITED-99';

async function extractionOf(pdfPath: string): Promise<string[]> {
  const require = createRequire(import.meta.url);
  const legacy = require('pdfjs-dist/legacy/build/pdf.mjs') as typeof import('pdfjs-dist');
  const task = legacy.getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    useSystemFonts: false,
    standardFontDataUrl: `${pathToFileURL(join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts')).href}/`,
  });
  const doc = await task.promise;
  try {
    const out: string[] = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      out.push(tc.items.map((i) => ('str' in i ? i.str : '')).join(' '));
    }
    return out;
  } finally {
    await task.destroy();
  }
}

test('edit-text: click a run, replace it, original line gone by rect, replacement searchable', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const outPath = join(testInfo.outputDir, 'out-edited.pdf');
  await buildAnnotateFixture(FIX_OUT);

  await page.goto('./tools/editor');
  await page.setInputFiles('input[type="file"]', FIX_OUT);
  await expect(page.getByTestId('editor-overlay')).toBeVisible({ timeout: 30_000 });

  // Switch to the edit tab; wait for the canvas, then for the run overlay.
  await page.getByRole('tab', { name: 'Sửa chữ' }).click();
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas');
      return !!c && c.width > 100 && c.height > 100;
    },
    undefined,
    { timeout: 30_000 },
  );
  const runButton = page.locator(`[aria-label="run-run-1-0"]`);
  await expect(runButton).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(300); // overlay click-region settle
  await runButton.click();

  // The edit list shows the original text; type the replacement.
  await expect(page.getByText('Gốc: ' + TARGET)).toBeVisible();
  await page.getByTestId('edit-replacement-input').fill(REPLACEMENT);
  await expect(page.getByText('1 chỗ sửa')).toBeVisible();

  await page.getByRole('button', { name: 'Áp dụng và tải xuống' }).click();
  const download = await page.waitForEvent('download', { timeout: 120_000 });
  expect(download.suggestedFilename()).toBe('edit-e2e-fixture-edited.pdf');
  await download.saveAs(outPath);

  const pages = await extractionOf(outPath);
  expect(pages[0]).toContain(REPLACEMENT);
  expect(pages[0]).not.toContain(TARGET);
  expect(pages[1]).toContain('Page two body text.'); // untouched page
});

test('edit-text: pure white-out (empty replacement) removes the line', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const outPath = join(testInfo.outputDir, 'out-white.pdf');
  await buildAnnotateFixture(FIX_OUT);

  await page.goto('./tools/editor');
  await page.setInputFiles('input[type="file"]', FIX_OUT);
  await expect(page.getByTestId('editor-overlay')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Sửa chữ' }).click();
  const runButton = page.locator(`[aria-label="run-run-1-0"]`);
  await expect(runButton).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(300);
  await runButton.click();
  await expect(page.getByText('Gốc: ' + TARGET)).toBeVisible();
  // Replacement stays empty → white-out.
  await page.getByRole('button', { name: 'Áp dụng và tải xuống' }).click();
  const download = await page.waitForEvent('download', { timeout: 120_000 });
  await download.saveAs(outPath);
  const pages = await extractionOf(outPath);
  expect(pages[0]).not.toContain(TARGET);
});
