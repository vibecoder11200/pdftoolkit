import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/*
 * Blank-pages e2e (v0.11.0 phase 9, plan 261109-1101): the mixed fixture
 * (3 content + 2 truly blank + 1 header-only) through the REAL detection
 * pipeline — the two blanks auto-check, the header-only page lands 'near'
 * and SURVIVES by default, removal delivers exactly the 4 kept pages
 * (verified by reloading the download through pdf.js in-test).
 */

const FIX = join('tests/fixtures/fixture-blank-mixed.pdf');

async function pageCountOf(pdfPath: string): Promise<number> {
  const require = createRequire(import.meta.url);
  const legacy = require('pdfjs-dist/legacy/build/pdf.mjs') as typeof import('pdfjs-dist');
  const task = legacy.getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    useSystemFonts: false,
    standardFontDataUrl: `${pathToFileURL(join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts')).href}/`,
  });
  const doc = await task.promise;
  try {
    return doc.numPages;
  } finally {
    await task.destroy();
  }
}

async function runDetection(page: Page): Promise<void> {
  await page.goto('./tools/blank-pages');
  await page.locator('input[type="file"]').first().setInputFiles(FIX);
  await expect(page.getByText('6 trang', { exact: false })).toBeVisible({ timeout: 30_000 });
  const cta = page.getByRole('button', { name: 'Phát hiện trang trắng' });
  await expect(cta).toBeEnabled({ timeout: 30_000 });
  await cta.click();
  await expect(page.getByText('2 trang trắng')).toBeVisible({ timeout: 60_000 });
}

test('blank-pages: blanks auto-check, header-only survives, removal yields 4 pages', async ({ page }) => {
  test.setTimeout(180_000);
  if (readFileSync(FIX).length === 0) throw new Error('fixture missing — run `node tests/fixtures/gen.mjs`');
  await runDetection(page);

  // Badges: exactly two Trắng. The header-only page carries a TEXT layer,
  // so the digital fast path classifies it content (no badge) — it
  // survives like the other content pages; 'near' is raster-only and is
  // pinned at the unit level (tests/blank-page.spec.ts).
  const badges = page.getByTestId('thumb-badge');
  await expect(badges.filter({ hasText: 'Trắng' })).toHaveCount(2);

  // Blank pages auto-checked: the CTA shows 2 selected without a click.
  await expect(page.getByRole('button', { name: 'Xóa 2 trang đã chọn' })).toBeVisible();

  // Header-only page (content, no badge) unchecked by default: toggle ON
  // (3 selected), then OFF again — the AC keeps the header, so removal
  // runs blanks-only.
  const headerCell = page.locator('[data-page-cell="6"]');
  // The badge wrapper span exists on every tile — clean tiles carry it EMPTY.
  await expect(headerCell.locator('[data-testid="thumb-badge"]')).toHaveText('');
  await headerCell.click();
  await expect(page.getByRole('button', { name: 'Xóa 3 trang đã chọn' })).toBeVisible();
  await headerCell.click();
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xóa 2 trang đã chọn' }).click();
  const out = await dl;
  expect(out.suggestedFilename()).toMatch(/-da-xoa-trang\.pdf$/);
  const path = join(await out.path());
  expect(await pageCountOf(path)).toBe(4);
});

test('blank-pages: header-only page checked then unchecked restores the blanks-only selection', async ({ page }) => {
  test.setTimeout(120_000);
  await runDetection(page);
  const headerCell = page.locator('[data-page-cell="6"]');
  await headerCell.click();
  await expect(page.getByRole('button', { name: 'Xóa 3 trang đã chọn' })).toBeVisible();
  await headerCell.click();
  await expect(page.getByRole('button', { name: 'Xóa 2 trang đã chọn' })).toBeVisible();
});
