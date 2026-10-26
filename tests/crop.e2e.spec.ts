import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAnnotateFixture } from './helpers/annotate-fixture';

/*
 * Crop e2e (v0.9.0 phase 7): drag a box on the crop tab, apply, download,
 * and prove with pdf.js that the page's VISUAL size shrank to the box
 * (the /CropBox contract) while the file still carries both pages.
 */

const FIX_OUT = 'test-results/crop-e2e-fixture.pdf';

async function visualSizeOf(pdfPath: string, pageNumber: number): Promise<{ width: number; height: number }> {
  const require = createRequire(import.meta.url);
  const legacy = require('pdfjs-dist/legacy/build/pdf.mjs') as typeof import('pdfjs-dist');
  const task = legacy.getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    useSystemFonts: false,
    standardFontDataUrl: `${pathToFileURL(join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts')).href}/`,
  });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(pageNumber);
    const vp = page.getViewport({ scale: 1 });
    return { width: vp.width, height: vp.height };
  } finally {
    await task.destroy();
  }
}

async function drawCropBox(page: Page, x0: number, y0: number, x1: number, y1: number) {
  await page.evaluate(() => window.scrollTo(0, 0));
  // Width alone is not enough — the async pdf.js render can resize the
  // canvas MID-DRAG (pinned race): wait for the fixture's actual aspect.
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas');
      return !!c && c.width > 100 && Math.abs(c.height / c.width - 842 / 595) < 0.02;
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(300);
  const overlay = page.getByTestId('crop-overlay');
  const box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * x0, box.y + box.height * y0);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1, { steps: 6 });
  await page.mouse.up();
}

test('crop: drag a box, apply to all pages, visual size shrinks on every page', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const outPath = join(testInfo.outputDir, 'out-cropped.pdf');
  await buildAnnotateFixture(FIX_OUT);

  await page.goto('./tools/editor');
  await page.setInputFiles('input[type="file"]', FIX_OUT);
  await expect(page.getByTestId('editor-overlay')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Cắt' }).click();

  // Drag the crop box on page 1 (fractions of the overlay): left-top half.
  await drawCropBox(page, 0.1, 0.08, 0.6, 0.5);
  await expect(page.getByTestId('crop-box')).toBeVisible();

  // Scope: all pages (default). Apply.
  // Register the download listener BEFORE the click — the op can deliver
  // faster than the click's own await resolves (flake pinned 2026-10-26).
  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Cắt', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('crop-e2e-fixture-cropped.pdf');
  await download.saveAs(outPath);

  // Fractions crop each page to ITS OWN visible box: page 1 is 595×842
  // (rot 0), page 2 is 842×595 (rot 90 — the swap).
  const expected = [
    { w: 595 * 0.5, h: 842 * 0.42 },
    { w: 842 * 0.5, h: 595 * 0.42 },
  ];
  for (const [i, p] of [1, 2].entries()) {
    const size = await visualSizeOf(outPath, p);
    expect(size.width, `page ${p} w`).toBeCloseTo(expected[i]!.w, 1);
    expect(size.height, `page ${p} h`).toBeCloseTo(expected[i]!.h, 1);
  }
});

test('crop: auto-suggest proposes a box the user can accept', async ({ page }) => {
  test.setTimeout(180_000);
  await buildAnnotateFixture(FIX_OUT);
  await page.goto('./tools/editor');
  await page.setInputFiles('input[type="file"]', FIX_OUT);
  await expect(page.getByTestId('editor-overlay')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Cắt' }).click();
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas');
      return !!c && c.width > 100 && c.height > 100;
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Gợi ý tự động' }).click();
  // The suggestion lands as the editable draft box (never silently applied
  // to the file — the user still presses Cắt).
  await expect(page.getByTestId('crop-box')).toBeVisible({ timeout: 15_000 });
});
