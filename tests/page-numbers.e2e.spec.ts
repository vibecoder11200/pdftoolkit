import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/*
 * Page-numbers tool e2e (v0.8.0 phase 5): preset 3 (localized template),
 * skip-first preset (clean cover page), and the advanced token template with
 * the {filename} token — each asserted against the downloaded artifact via
 * the pdfjs-dist legacy build in the node context. The fixture's own header
 * ("… — page 1/5") means number assertions must match the STAMP form
 * ("Trang n/5") or item-level exact strings, never a loose /\d\/5/.
 */

const FIX = 'tests/fixtures';

async function pdfjsLegacy() {
  const require = createRequire(import.meta.url);
  return require('pdfjs-dist/legacy/build/pdf.mjs') as typeof import('pdfjs-dist');
}

async function itemStringsOf(pdfPath: string, pageNumbers: number[]): Promise<string[][]> {
  const legacy = await pdfjsLegacy();
  const task = legacy.getDocument({ data: new Uint8Array(readFileSync(pdfPath)) });
  const doc = await task.promise;
  try {
    const out: string[][] = [];
    for (const n of pageNumbers) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      out.push(tc.items.map((i) => ('str' in i ? String(i.str) : '')));
    }
    return out;
  } finally {
    await task.destroy();
  }
}

async function loadFixture(page: import('@playwright/test').Page) {
  await page.goto('./tools/page-numbers');
  await page.setInputFiles('input[type="file"]', `${FIX}/fixture-pagenums.pdf`);
  await expect(page.locator('[role="checkbox"]')).toHaveCount(5, { timeout: 30_000 });
}

async function runAndDownload(page: import('@playwright/test').Page): Promise<string> {
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Đánh số và tải xuống' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('fixture-pagenums-numbered.pdf');
  return (await download.path())!;
}

test('preset 3 numbers every page "Trang n/5" (vi template pinned)', async ({ page }) => {
  await loadFixture(page);
  await page.locator('input[name="pagenums-preset"]').nth(2).check();
  const path = await runAndDownload(page);
  for (const p of [1, 2, 3, 4, 5]) {
    const items = (await itemStringsOf(path, [p]))[0];
    expect(items.join(' '), `page ${p}`).toContain(`Trang ${p}/5`);
  }
});

test('skip-first preset leaves page 1 clean, numbers 2..5', async ({ page }) => {
  await loadFixture(page);
  await page.locator('input[name="pagenums-preset"]').nth(3).check();
  const path = await runAndDownload(page);
  const [p1, p2] = await itemStringsOf(path, [1, 2]);
  // Bare {n}/{total} template: a stamp item is EXACTLY "n/5" — the fixture's
  // own header sentence ("page 1/5") must never read as a stamp.
  expect(p1.some((s) => /^\d+\/5$/.test(s.trim()))).toBe(false);
  expect(p2.map((s) => s.trim())).toContain('2/5');
});

test('advanced template "Trang {n} — {filename}" resolves the basename', async ({ page }) => {
  await loadFixture(page);
  await page.locator('input[name="pagenums-preset"]').nth(4).check();
  const template = page.locator('input[type="text"]');
  await template.fill('Trang {n} — {filename}');
  // Live preview (pure renderPageTemplate) renders pages 1–3 instantly.
  await expect(page.getByText('Trang 1 — fixture-pagenums').first()).toBeVisible();
  const path = await runAndDownload(page);
  const [p1, p3] = await itemStringsOf(path, [1, 3]);
  expect(p1.join(' ')).toContain('Trang 1 — fixture-pagenums');
  expect(p3.join(' ')).toContain('Trang 3 — fixture-pagenums');
});
