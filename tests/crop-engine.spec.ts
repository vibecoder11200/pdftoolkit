import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees as pdfLibDegrees } from 'pdf-lib';
import { CropRefusedError, cropPages } from '../src/engine/pdf-lib';
import { contentBboxFromPixels, unionFrac, padFrac } from '../src/lib/content-bbox';

/*
 * Crop engine (v0.9.0 phase 7) — the geometry property matrix over
 * rotation × pre-existing CropBox, the expected /CropBox asserted via a
 * pdf-lib reload, MediaBox unchanged, and the redact-ordering interlocks
 * (crop-after-redact sees normalized geometry; redact-after-crop respects
 * the new box). Plus the content-bbox auto-suggest pure functions.
 */

async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  // rot sweep 0/90/180/270 on 400×300; page 5 cropped ⊊ MediaBox @ rot 90.
  for (const rot of [0, 90, 180, 270]) {
    const page = doc.addPage([400, 300]);
    page.drawText('crop me', { x: 20, y: 20, size: 10, font: helv });
    page.setRotation(pdfLibDegrees(rot));
  }
  const cropped = doc.addPage([400, 300]);
  cropped.setCropBox(50, 50, 250, 200);
  cropped.setRotation(pdfLibDegrees(90));
  return doc.save({ useObjectStreams: false });
}

describe('cropPages — geometry property matrix', () => {
  it('sets the expected user-space CropBox on every rotation + cropped page', async () => {
    const { visibleGeometry, visualToPageSpace } = await import('../src/engine/pdf-lib');
    const base = await buildFixture();
    // Pre-crop geometry per page (the primitives are the v0.8 contract the
    // watermark property matrix already validates against pdf.js).
    const pre = await PDFDocument.load(base);
    const geoms = pre.getPages().map((p) => visibleGeometry(p));
    // The same VISUAL-fraction box (centred band) on every page.
    const frac = { x: 0.1, y: 0.2, w: 0.6, h: 0.5 };
    const out = await cropPages(
      base,
      geoms.map((_, i) => ({ page: i + 1, rect: frac })),
    );
    const doc = await PDFDocument.load(out);
    for (const [i, page] of doc.getPages().entries()) {
      const g = geoms[i]!;
      const c0 = visualToPageSpace(frac.x * g.visualWidth, frac.y * g.visualHeight, g);
      const c1 = visualToPageSpace(
        (frac.x + frac.w) * g.visualWidth,
        (frac.y + frac.h) * g.visualHeight,
        g,
      );
      const cb = page.getCropBox();
      expect(cb.x, `page ${i + 1} x`).toBeCloseTo(Math.min(c0.x, c1.x), 4);
      expect(cb.y, `page ${i + 1} y`).toBeCloseTo(Math.min(c0.y, c1.y), 4);
      expect(cb.width, `page ${i + 1} w`).toBeCloseTo(Math.abs(c1.x - c0.x), 4);
      expect(cb.height, `page ${i + 1} h`).toBeCloseTo(Math.abs(c1.y - c0.y), 4);
      // MediaBox untouched.
      const mb = page.getMediaBox();
      expect(mb.width).toBe(400);
      expect(mb.height).toBe(300);
    }
    // pdf.js visual-size oracle: the DISPLAYED page is exactly the box.
    const { getPageVisualSize } = await import('../src/engine/pdfjs');
    for (const [i, g] of geoms.entries()) {
      const size = await getPageVisualSize(new Uint8Array(out), i + 1);
      expect(size.width, `page ${i + 1} visual w`).toBeCloseTo(frac.w * g.visualWidth, 2);
      expect(size.height, `page ${i + 1} visual h`).toBeCloseTo(frac.h * g.visualHeight, 2);
    }
  });

  it('crop-of-crop narrows an existing CropBox (clamped inside)', async () => {
    const base = await buildFixture();
    // Page 5 visible box is 200×250 visual — crop the right half.
    const out = await cropPages(
      base,
      [{ page: 5, rect: { x: 0.5, y: 0.25, w: 0.6, h: 0.6 } }],
    );
    const doc = await PDFDocument.load(out);
    const page = doc.getPage(4);
    const cb = page.getCropBox();
    // Clamped: x+w stays within the original user box (50..300, 50..250).
    // frac x .5..1.1 → clamped to 1.0 of the visual width.
    expect(cb.x + cb.width).toBeLessThanOrEqual(300.001);
    expect(cb.y + cb.height).toBeLessThanOrEqual(250.001);
    expect(cb.width).toBeGreaterThan(1);
    expect(cb.height).toBeGreaterThan(1);
  });

  it('degenerate + out-of-range + encrypted inputs refuse, input untouched', async () => {
    const base = await buildFixture();
    const before = base.slice();
    // Sub-point sliver at the page edge (0.002 × 400pt = 0.8pt wide).
    await expect(
      cropPages(base, [{ page: 1, rect: { x: 0.999, y: 0, w: 0.002, h: 0.5 } }]),
    ).rejects.toBeInstanceOf(CropRefusedError);
    await expect(
      cropPages(base, [{ page: 99, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }]),
    ).rejects.toBeInstanceOf(CropRefusedError);
    await expect(
      cropPages(base, [{ page: 1, rect: { x: 0.5, y: 0.5, w: -0.1, h: 0.5 } }]),
    ).rejects.toBeInstanceOf(CropRefusedError);
    expect(base).toEqual(before);
    const { encryptPdf } = await import('../src/engine/qpdf');
    const enc = await encryptPdf(base, 'user-pass', 'owner-pass');
    await expect(
      cropPages(enc, [{ page: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }]),
    ).rejects.toBeInstanceOf(CropRefusedError);
  });
});

describe('crop ↔ redact ordering interlocks', () => {
  it('crop-after-redact: a raster-normalized page (CropBox==MediaBox) crops cleanly', async () => {
    const { redactFinalize, redactCensus } = await import('../src/engine/pdf-lib');
    const base = await buildFixture();
    const census = await redactCensus(base);
    expect(census.pages).toHaveLength(0); // fixture is census-clean
    // Surgical redact (no raster tier needed — census-clean).
    const out = await redactFinalize(base, {
      secrets: ['crop me'],
      surgical: [{ page: 1, rects: [{ x: 10, y: 10, w: 120, h: 24 }] }],
    });
    // Then crop the redacted output — sees normalized geometry.
    const cropped = await cropPages(out.bytes, [
      { page: 1, rect: { x: 0, y: 0, w: 0.5, h: 1 } },
    ]);
    const doc = await PDFDocument.load(cropped);
    expect(doc.getPage(0).getCropBox().width).toBeCloseTo(200, 4);
  });

  it('redact-after-crop: redaction on a cropped page keeps the narrowed visible box', async () => {
    const { redactFinalize, redactCensus } = await import('../src/engine/pdf-lib');
    const base = await buildFixture();
    // Crop FIRST (page 1 → left half), then redact inside the narrowed page.
    const cropped = await cropPages(base, [
      { page: 1, rect: { x: 0, y: 0, w: 0.5, h: 1 } },
    ]);
    const census = await redactCensus(cropped);
    expect(census.pages).toHaveLength(0);
    const out = await redactFinalize(cropped, {
      secrets: ['crop me'],
      surgical: [{ page: 1, rects: [{ x: 10, y: 10, w: 60, h: 20 }] }],
    });
    const doc = await PDFDocument.load(out.bytes);
    const p = doc.getPage(0);
    expect(p.getCropBox().width).toBeCloseTo(200, 4);
    expect(p.getMediaBox().width).toBe(400); // surgical keeps boxes intact
  });

  it('raster-redact after crop: the replacement page normalizes to the CROPPED box', async () => {
    const { redactFinalize } = await import('../src/engine/pdf-lib');
    const { createCanvas } = await import('@napi-rs/canvas');
    const base = await buildFixture();
    const cropped = await cropPages(base, [
      { page: 1, rect: { x: 0, y: 0, w: 0.5, h: 1 } },
    ]);
    // 4×3 white JPEG as the replacement raster.
    const canvas = createCanvas(4, 3);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 4, 3);
    const jpeg = new Uint8Array(canvas.toBuffer('image/jpeg', 90));
    const out = await redactFinalize(cropped, {
      secrets: ['PDFTOOLKIT-CROP'],
      raster: [{ page: 1, jpeg }],
    });
    const doc = await PDFDocument.load(out.bytes);
    const p = doc.getPage(0);
    expect(p.getCropBox().width).toBeCloseTo(p.getMediaBox().width, 4);
    expect(p.getMediaBox().width).toBeCloseTo(200, 4);
    expect(p.getMediaBox().height).toBeCloseTo(300, 4);
  });
});

describe('content-bbox — auto-suggest pure functions', () => {
  it('finds the ink bounding box with tolerance', () => {
    const w = 100;
    const h = 80;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    // Ink block at x 20..49, y 30..59.
    for (let y = 30; y < 60; y += 1) {
      for (let x = 20; x < 50; x += 1) {
        const o = (y * w + x) * 4;
        data[o] = 0;
        data[o + 1] = 0;
        data[o + 2] = 0;
      }
    }
    const box = contentBboxFromPixels(w, h, data);
    expect(box).toEqual({ nx: 0.2, nyTop: 30 / 80, nw: 0.3, nh: 30 / 80 });
  });

  it('returns null on a blank page and unions/pads correctly', () => {
    const data = new Uint8ClampedArray(10 * 10 * 4).fill(255);
    expect(contentBboxFromPixels(10, 10, data)).toBeNull();
    const a = { nx: 0.1, nyTop: 0.1, nw: 0.2, nh: 0.2 };
    const b = { nx: 0.5, nyTop: 0.4, nw: 0.2, nh: 0.2 };
    const u = unionFrac(a, b)!;
    expect(u.nx).toBeCloseTo(0.1, 9);
    expect(u.nyTop).toBeCloseTo(0.1, 9);
    expect(u.nw).toBeCloseTo(0.6, 9);
    expect(u.nh).toBeCloseTo(0.5, 9);
    expect(unionFrac(null, b)).toEqual(b);
    const padded = padFrac(a, 0.05);
    expect(padded.nx).toBeCloseTo(0.05, 9);
    expect(padded.nyTop).toBeCloseTo(0.05, 9);
    expect(padded.nw).toBeCloseTo(0.3, 9);
    expect(padded.nh).toBeCloseTo(0.3, 9);
    // Padding clamps at the page edge.
    expect(padFrac({ nx: 0, nyTop: 0, nw: 0.9, nh: 0.9 }, 0.2).nw).toBeCloseTo(1, 6);
  });

  it('grey background below tolerance does not count as ink', () => {
    const w = 40;
    const h = 40;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
      data[i * 4] = 240;
      data[i * 4 + 1] = 240;
      data[i * 4 + 2] = 240;
      data[i * 4 + 3] = 255;
    }
    expect(contentBboxFromPixels(w, h, data, 28)).toBeNull();
  });
});

async function signedDocBytes(): Promise<Uint8Array> {
  const { PDFDocument, PDFName, PDFString, PDFNumber, PDFHexString } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.addPage([300, 144]);
  const ctx = doc.context;
  const sigValue = ctx.register(ctx.obj({ ByteRange: ctx.obj([0, 1, 2, 3].map((n) => PDFNumber.of(n))), Contents: PDFHexString.fromText('sig') }));
  const fieldRef = ctx.register(ctx.obj({ FT: PDFName.of('Sig'), T: PDFString.of('Sig1'), V: sigValue }));
  doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: ctx.obj([fieldRef]) }));
  return doc.save({ useObjectStreams: false });
}

it('signed document refuses before mutation (review decision 2026-10-27)', async () => {
  const bytes = await signedDocBytes();
  await expect(
    cropPages(bytes, [{ page: 1, rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }]),
  ).rejects.toMatchObject({ name: 'CropRefusedError' });
});
