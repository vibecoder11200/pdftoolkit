import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRedactFixture, REDACT_KEYWORDS, REDACT_SECRET } from './helpers/redact-fixture';
import { regionSpread } from '../src/lib/redact-pipeline';

/*
 * Redact e2e (v0.9.0 phase 3) — the invisible-failure guard is a RELEASE
 * gate: after apply, the secret must be unfindable via EXTRACTION on the
 * surgical page, a raster-escalated page must yield NO text at all, and a
 * painted mark region must be PIXEL-uniform in the re-render (finding 1).
 * The oracle is pdfjs-dist legacy right here in the Playwright node context
 * (watermark e2e precedent), with @napi-rs/canvas for the pixel leg.
 */

const FIX_OUT = 'test-results/redact-e2e-fixture.pdf';

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
      out.push(tc.items.map((i) => ('str' in i ? String(i.str) : '')).join(' '));
    }
    return out;
  } finally {
    await task.destroy();
  }
}

async function metadataTitleOf(pdfPath: string): Promise<string> {
  const legacy = await pdfjsLegacy();
  const task = legacy.getDocument({ data: new Uint8Array(readFileSync(pdfPath)) });
  const doc = await task.promise;
  try {
    const meta = await doc.getMetadata();
    return String((meta.info as { Title?: string }).Title ?? '');
  } finally {
    await task.destroy();
  }
}

/** Renders one page with @napi-rs/canvas and returns the ImageData-like
 * bitmap for the pixel-uniformity leg (same wiring as the engine spec). */
async function renderedPage(
  pdfPath: string,
  pageNumber: number,
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
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
    await page.render({
      canvas,
      viewport: vp,
      annotationMode: 0,
    } as unknown as Parameters<typeof page.render>[0]).promise;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: img.data, width: img.width, height: img.height };
  } finally {
    await task.destroy();
  }
}

/** Drags a mark over the header band of the currently shown page. Waits for
 * pdf.js to size the canvas first — measuring mid-render catches a stale box
 * (the render resizes the wrapper, compressing the drag to a sub-threshold
 * sliver) — and scrolls to top so side-panel auto-scrolls cannot push the
 * drag point under the sticky nav. */
async function markBand(page: Page, x0: number, x1: number, y0: number, y1: number) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas');
    return !!c && c.width > 100 && c.height > 100;
  }, undefined, { timeout: 30_000 });
  // A scroll settling asynchronously under a drag compresses the normalized
  // deltas below the component's minimum-mark threshold (probed: scroll+drag
  // races, scroll+settle+drag never does).
  await page.waitForTimeout(300);
  const overlay = page.getByTestId('editor-overlay');
  const box = (await overlay.boundingBox())!;
  const cx = box.x;
  const cy = box.y;
  await page.mouse.move(cx + box.width * x0, cy + box.height * y0);
  await page.mouse.down();
  await page.mouse.move(cx + box.width * x1, cy + box.height * y1, { steps: 6 });
  await page.mouse.up();
}

test('redact: surgical page cleans by extraction, flagged page burns clean, marks paint pixels, channels scrub', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const outPath = join(testInfo.outputDir, 'out.pdf');
  await buildRedactFixture(FIX_OUT);

  await page.goto('./tools/editor');
  await page.setInputFiles('input[type="file"]', FIX_OUT);
  await expect(page.getByTestId('editor-overlay')).toBeVisible({ timeout: 30_000 });
  // Census: page 2 carries a form widget → flagged, burn ON by default.
  await expect(page.getByRole('button', { name: 'Đốt trang', exact: true })).toHaveCount(1);
  const burnBtn = page.getByRole('button', { name: 'Đốt trang', exact: true });
  await expect(burnBtn).toHaveAttribute('aria-pressed', 'true');

  // Mark the secret header on page 1 (surgical), then a band on page 2 too
  // (flagged → raster; the band must be PAINTED before encode — finding 1).
  await markBand(page, 0.04, 0.62, 0.025, 0.062);
  await page.getByRole('button', { name: '→' }).click();
  await expect(page.getByText('Trang 2/2')).toBeVisible();
  await markBand(page, 0.04, 0.62, 0.22, 0.28); // over the form field area

  await page
    .locator('textarea')
    .fill(REDACT_KEYWORDS);
  await page.getByRole('button', { name: 'Xác nhận che đi' }).click();

  const download = await page.waitForEvent('download', { timeout: 120_000 });
  expect(download.suggestedFilename()).toBe('redact-e2e-fixture-redacted.pdf');
  await download.saveAs(outPath);

  // EXTRACTION leg: page 1 surgical — public body survives, secret gone.
  const pages = await extractionOf(outPath);
  expect(pages).toHaveLength(2);
  expect(pages[0]).toContain('Body line one');
  expect(pages[0]).not.toContain(REDACT_SECRET);
  // Page 2 burned — a rasterized page yields NO text at all.
  expect(pages[1]!.replace(/\s+/g, '')).toBe('');

  // DOC-CHANNEL leg: info:Title scrubbed on match.
  expect(await metadataTitleOf(outPath)).not.toContain(REDACT_SECRET);

  // PIXEL leg: the page-2 mark band must be uniformly covered in a
  // re-render (finding 1 — an unpainted raster would ship the widget as
  // pixels; a failed paint shows content bleed > tolerance).
  const img = await renderedPage(outPath, 2);
  const spread = regionSpread(img, { nx: 0.04, nyTop: 0.22, nw: 0.58, nh: 0.06 });
  expect(spread).toBeLessThanOrEqual(40);
});

test('redact: run is refused before any mark/burn exists, and refusal paths deliver nothing', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await buildRedactFixture(FIX_OUT);

  await page.goto('./tools/editor');
  await page.setInputFiles('input[type="file"]', FIX_OUT);
  await expect(page.getByTestId('editor-overlay')).toBeVisible({ timeout: 30_000 });

  // The flagged page defaults to burn, so flip it to "keep" first — with no
  // marks AND no burn the run cannot start (button disabled, nothing delivered).
  await page.getByRole('button', { name: 'Giữ nguyên' }).click();
  const apply = page.getByRole('button', { name: 'Xác nhận che đi' });
  await expect(apply).toBeDisabled();

  // With marks present but NO keywords, apply surfaces the secrets error and
  // no download ever starts.
  await markBand(page, 0.04, 0.62, 0.025, 0.062);
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByText('Nhập ít nhất một từ khóa')).toBeVisible();
  await page.waitForEvent('download', { timeout: 5_000 }).then(
    () => {
      throw new Error('a download started despite the missing-keyword refusal');
    },
    () => {
      /* expected timeout — nothing delivered */
    },
  );
});
