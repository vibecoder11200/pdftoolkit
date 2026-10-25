import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAnnotateFixture } from './helpers/annotate-fixture';

/*
 * Annotate e2e (v0.9.0 phase 4): place a text stamp via drag on the live
 * canvas, apply, and prove with the pdf.js oracle that the glyph landed at
 * its VISUAL position — including on a /Rotate 90 page (the watermark
 * engine's placement contract, exercised through the tool UI).
 */

const FIX_OUT = 'test-results/annotate-e2e-fixture.pdf';
const STAMP_TEXT = 'ANNOTATE-42';

async function pdfjsLegacy() {
  const require = createRequire(import.meta.url);
  return require('pdfjs-dist/legacy/build/pdf.mjs') as typeof import('pdfjs-dist');
}

async function extractionOf(pdfPath: string): Promise<string[]> {
  const legacy = await pdfjsLegacy();
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

/** Ink fraction inside a VISUAL-space rect (bottom-left origin, y up). */
async function inkAt(pdfPath: string, pageNumber: number, box: { x: number; y: number; w: number; h: number }, visW: number, visH: number): Promise<number> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const legacy = await pdfjsLegacy();
  const task = legacy.getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    useSystemFonts: false,
    standardFontDataUrl: `${pathToFileURL(join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts')).href}/`,
    canvasFactory: {
      create(w: number, h: number) {
        const c = createCanvas(w, h);
        return { canvas: c, context: c.getContext('2d') };
      },
      reset(cf: { canvas: { width: number; height: number } }, w: number, h: number) {
        cf.canvas.width = w;
        cf.canvas.height = h;
      },
      destroy(cf: { canvas: { width: number; height: number } }) {
        cf.canvas.width = 0;
        cf.canvas.height = 0;
      },
    },
  } as unknown as Parameters<typeof import('pdfjs-dist')['getDocument']>[0]);
  const doc = await task.promise;
  try {
    const page = await doc.getPage(pageNumber);
    const vp = page.getViewport({ scale: 1.2 });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, viewport: vp, annotationMode: 0 } as unknown as Parameters<typeof page.render>[0]).promise;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const x0 = Math.round((box.x / visW) * img.width);
    const x1 = Math.round(((box.x + box.w) / visW) * img.width);
    const y0 = Math.round(((visH - box.y - box.h) / visH) * img.height);
    const y1 = Math.round(((visH - box.y) / visH) * img.height);
    let inked = 0;
    let total = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const o = (y * img.width + x) * 4;
        total += 1;
        if (img.data[o]! < 200 || img.data[o + 1]! < 200 || img.data[o + 2]! < 200) inked += 1;
      }
    }
    return total === 0 ? 0 : inked / total;
  } finally {
    await task.destroy();
  }
}

async function drawBox(page: Page, x0: number, y0: number, x1: number, y1: number) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas');
      return !!c && c.width > 100 && c.height > 100;
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(300);
  const overlay = page.getByTestId('annotate-overlay');
  const box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * x0, box.y + box.height * y0);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1, { steps: 6 });
  await page.mouse.up();
}

test('annotate: drag a text stamp, apply, stamp lands at the visual position', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const outPath = join(testInfo.outputDir, 'out.pdf');
  await buildAnnotateFixture(FIX_OUT);

  await page.goto('./tools/editor');
  await page.setInputFiles('input[type="file"]', FIX_OUT);
  await expect(page.getByTestId('editor-overlay')).toBeVisible({ timeout: 30_000 });

  // Switch to the annotate tab and stamp with a known string.
  await page.getByRole('tab', { name: 'Ghi chú' }).click();
  await expect(page.getByTestId('annotate-overlay')).toBeVisible();
  const apply = page.getByRole('button', { name: 'Áp dụng và tải xuống' });
  await expect(apply).toBeDisabled(); // nothing drawn yet
  await page.getByLabel('Nội dung chữ').fill(STAMP_TEXT);

  // Draw on page 1: top-left quadrant drag (fractions of the overlay).
  await drawBox(page, 0.08, 0.08, 0.45, 0.16);
  await expect(apply).toBeEnabled();

  // The element list shows the text stamp on this page.
  await expect(page.getByText('· ' + STAMP_TEXT)).toBeVisible();

  await apply.click();
  const download = await page.waitForEvent('download', { timeout: 120_000 });
  expect(download.suggestedFilename()).toBe('annotate-e2e-fixture-annotated.pdf');
  await download.saveAs(outPath);

  // Extraction: the stamp text is on page 1 only.
  const pages = await extractionOf(outPath);
  expect(pages[0]).toContain(STAMP_TEXT);
  expect(pages[1]).not.toContain(STAMP_TEXT);
  // Body text untouched.
  expect(pages[0]).toContain('Page one body text.');

  // Position: the stamp is inked inside the drawn box. Glyphs cover a small
  // fraction of the whole box, so probe ~80pt around the baseline: the box
  // bottom in VISUAL space is (1 − nyTop − nh)·842 ≈ 707 (baseline).
  const baseline = 842 * (1 - 0.08 - 0.08);
  const ink = await inkAt(outPath, 1, { x: 595 * 0.08 + 1, y: baseline, w: 80, h: 18 }, 595, 842);
  expect(ink).toBeGreaterThan(0.08);
});

test('annotate: undo removes the element and apply stays disabled', async ({ page }) => {
  test.setTimeout(120_000);
  await buildAnnotateFixture(FIX_OUT);
  await page.goto('./tools/editor');
  await page.setInputFiles('input[type="file"]', FIX_OUT);
  await expect(page.getByTestId('editor-overlay')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Ghi chú' }).click();
  await drawBox(page, 0.08, 0.08, 0.45, 0.16);
  const apply = page.getByRole('button', { name: 'Áp dụng và tải xuống' });
  await expect(apply).toBeEnabled();
  await expect(page.getByText('1 phần tử')).toBeVisible();
  await page.getByRole('button', { name: 'Hoàn tác' }).click();
  await expect(page.getByText('0 phần tử')).toBeVisible();
  await expect(apply).toBeDisabled();
});
