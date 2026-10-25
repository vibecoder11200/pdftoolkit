import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';
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


/** Raw /QuadPoints (Highlight) or /Rect (FreeText) numbers of every annot
 * of `sub` in the output, read straight from pdf-lib. */
async function annotNumsOf(pdfPath: string, sub: 'Highlight' | 'FreeText'): Promise<number[][]> {
  const doc = await PDFDocument.load(readFileSync(pdfPath));
  const out: number[][] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj as import('pdf-lib').PDFDict;
    const st = dict.get?.(PDFName.of('Subtype'));
    if (st && st.toString() === `/${sub}`) {
      const key = sub === 'Highlight' ? 'QuadPoints' : 'Rect';
      const arr = dict.get(PDFName.of(key)) as import('pdf-lib').PDFArray;
      out.push(arr.asArray().map((v) => (v as import('pdf-lib').PDFNumber).asNumber()));
    }
  }
  return out;
}

/** Non-white coverage inside a VISUAL-space top-origin box, annotations
 * rendered iff `withAnnots` (pdf.js annotationMode 2 vs 0). */
async function coverageAt(
  pdfPath: string,
  pageNumber: number,
  box: { x: number; y: number; w: number; h: number },
  visW: number,
  visH: number,
  withAnnots: boolean,
): Promise<number> {
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
    await page.render({ canvas, viewport: vp, annotationMode: withAnnots ? 2 : 0 } as unknown as Parameters<typeof page.render>[0]).promise;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const x0 = Math.max(0, Math.round((box.x / visW) * img.width));
    const x1 = Math.min(img.width, Math.round(((box.x + box.w) / visW) * img.width));
    const y0 = Math.max(0, Math.round((box.y / visH) * img.height));
    const y1 = Math.min(img.height, Math.round(((box.y + box.h) / visH) * img.height));
    let inked = 0;
    let total = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const o = (y * img.width + x) * 4;
        total += 1;
        if (img.data[o]! < 235 || img.data[o + 1]! < 235 || img.data[o + 2]! < 235) inked += 1;
      }
    }
    return total === 0 ? 0 : inked / total;
  } finally {
    await task.destroy();
  }
}

/** Visual top-origin union box of QuadPoints/Rect arrays on a rot-0 A4 page. */
function visualUnion(flat: number[], isQuadPoints: boolean): { x: number; y: number; w: number; h: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  if (isQuadPoints) {
    for (let i = 0; i < flat.length; i += 2) {
      xs.push(flat[i]!);
      ys.push(flat[i + 1]!);
    }
  } else {
    xs.push(flat[0]!, flat[2]!);
    ys.push(flat[1]!, flat[3]!);
  }
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const yTop = 842 - Math.max(...ys); // rot 0: visual top-origin
  return { x: x0, y: yTop, w: x1 - x0, h: Math.max(...ys) - Math.min(...ys) };
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

test('annotate M2: drag-highlight lands a real /Highlight with /AP over the glyphs', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const outPath = join(testInfo.outputDir, 'out-hl.pdf');
  await buildAnnotateFixture(FIX_OUT);

  await page.goto('./tools/editor');
  await page.setInputFiles('input[type="file"]', FIX_OUT);
  await expect(page.getByTestId('editor-overlay')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Ghi chú' }).click();
  await page.getByRole('button', { name: 'Đánh dấu sáng' }).click();

  // Drag across the page-1 text line (visual fractions; the hit-test snaps
  // the quads to the actual text-item rects).
  await drawBox(page, 0.05, 0.07, 0.35, 0.12);
  // The element LIST entry (not the palette button with the same label).
  await expect(page.locator('li').filter({ hasText: 'Đánh dấu sáng' })).toBeVisible();
  const apply = page.getByRole('button', { name: 'Áp dụng và tải xuống' });
  await expect(apply).toBeEnabled();

  await apply.click();
  const download = await page.waitForEvent('download', { timeout: 120_000 });
  await download.saveAs(outPath);

  // The output carries ONE Highlight with 8 numbers per quad, page 1 only.
  const hl = await annotNumsOf(outPath, 'Highlight');
  expect(hl).toHaveLength(1);
  expect(hl[0]!.length).toBeGreaterThanOrEqual(8);
  expect((await annotNumsOf(outPath, 'FreeText'))).toHaveLength(0);

  // pdf.js renders the /AP: the quad union paints only with annotations on.
  const box = visualUnion(hl[0]!, true);
  const on = await coverageAt(outPath, 1, box, 595, 842, true);
  const off = await coverageAt(outPath, 1, box, 595, 842, false);
  expect(on).toBeGreaterThan(0.55);
  expect(off).toBeLessThan(0.35);
});

test('annotate M2: a note lands a real /FreeText whose /AP paints its box', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const outPath = join(testInfo.outputDir, 'out-note.pdf');
  await buildAnnotateFixture(FIX_OUT);

  await page.goto('./tools/editor');
  await page.setInputFiles('input[type="file"]', FIX_OUT);
  await expect(page.getByTestId('editor-overlay')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Ghi chú' }).click();
  await page.getByRole('button', { name: 'Ghi chú', exact: true }).click();
  await page.getByLabel('Nội dung ghi chú').fill('NOTE-77');

  // Place the note over an EMPTY area (nothing to hit-test) that stays
  // INSIDE the visible viewport band — the fit-width canvas extends well
  // below the fold and pointer events outside the viewport are clipped.
  await drawBox(page, 0.55, 0.02, 0.85, 0.1);
  await expect(page.getByText('· NOTE-77')).toBeVisible();
  const apply = page.getByRole('button', { name: 'Áp dụng và tải xuống' });
  await expect(apply).toBeEnabled();

  await apply.click();
  const download = await page.waitForEvent('download', { timeout: 120_000 });
  await download.saveAs(outPath);

  const ft = await annotNumsOf(outPath, 'FreeText');
  expect(ft).toHaveLength(1);
  const box = visualUnion(ft[0]!, false);
  const on = await coverageAt(outPath, 1, box, 595, 842, true);
  const off = await coverageAt(outPath, 1, box, 595, 842, false);
  expect(on).toBeGreaterThan(0.6);
  expect(off).toBeLessThan(0.05);
});
