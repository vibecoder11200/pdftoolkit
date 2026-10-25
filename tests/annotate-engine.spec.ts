import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees as pdfLibDegrees } from 'pdf-lib';
import {
  AnnotationRefusedError,
  stampAnnotations,
  visualToPageSpace,
  visibleGeometry,
  type AnnotateElement,
} from '../src/engine/pdf-lib';
import { encryptPdf } from '../src/engine/qpdf';

/*
 * Annotate engine (v0.9.0 phase 4) — the geometry property matrix, the
 * watermark-engine contract extended to free placement + 4 element kinds:
 * every kind lands at its pointer-dropped VISUAL position across rotation
 * (0/90/180/270) and crop, proven with the pdf.js render oracle
 * (@napi-rs/canvas ink probes) plus extraction for text.
 */

const ROOT = join(import.meta.dirname, '..');
const ROBOTO = join(ROOT, 'src', 'assets', 'fonts', 'Roboto-Regular.ttf');
const robotoBytes = () => new Uint8Array(readFileSync(ROBOTO));

async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  // Rotation sweep on full A6-ish pages.
  for (const rot of [0, 90, 180, 270]) {
    const page = doc.addPage([400, 300]);
    page.drawText(`rot ${rot}`, { x: 20, y: 20, size: 10, font: helv });
    page.setRotation(pdfLibDegrees(rot));
  }
  // Cropped + rotated page: CropBox [50,50,250,200] → visual 200×150 @ rot 90.
  const cropped = doc.addPage([400, 300]);
  cropped.setCropBox(50, 50, 250, 200);
  cropped.setRotation(pdfLibDegrees(90));
  return doc.save({ useObjectStreams: false });
}

let pdfjsMod: typeof import('pdfjs-dist') | null = null;
async function pdfjsLegacy(): Promise<typeof import('pdfjs-dist')> {
  pdfjsMod ??= (await import(
    pathToFileURL(join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href
  )) as typeof import('pdfjs-dist');
  return pdfjsMod;
}

interface Bitmap {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Renders page p1 in VISUAL orientation at `scale` pt→px over white. */
async function renderVisual(bytes: Uint8Array, p1: number, scale: number): Promise<Bitmap> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const pdfjs = await pdfjsLegacy();
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    standardFontDataUrl: `${pathToFileURL(join(ROOT, 'node_modules/pdfjs-dist/standard_fonts')).href}/`,
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
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = await task.promise;
  try {
    const page = await doc.getPage(p1);
    const vp = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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

/** Fraction of pixels in a VISUAL-space rect that carry ink (any channel
 * pulled well below white). */
function inkFraction(img: Bitmap, vx: number, vyTop: number, vw: number, vh: number, visW: number, visH: number): number {
  const x0 = Math.max(0, Math.round(vx * img.width / visW));
  const x1 = Math.min(img.width, Math.round((vx + vw) * img.width / visW));
  const y0 = Math.max(0, Math.round(vyTop * img.height / visH));
  const y1 = Math.min(img.height, Math.round((vyTop + vh) * img.height / visH));
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
}

describe('stampAnnotations — geometry property matrix (pdf.js oracle)', () => {
  it('filled rect lands in its visual box on every rotation and a cropped+rotated page', async () => {
    const base = await buildFixture();
    const elements: AnnotateElement[] = [];
    // Visual dims per fixture page: a /Rotate 90|270 page SWAPS its box
    // (400×300 user → 300×400 visual); page 5 crop [50,50,250,200] @ rot 90
    // displays as 200×250.
    const geoPerPage: { visW: number; visH: number }[] = [
      { visW: 400, visH: 300 },
      { visW: 300, visH: 400 },
      { visW: 400, visH: 300 },
      { visW: 300, visH: 400 },
      { visW: 200, visH: 250 },
    ];
    geoPerPage.forEach((g, i) => {
      elements.push({
        kind: 'rect',
        page: i + 1,
        x: g.visW * 0.25,
        y: g.visH * 0.35,
        w: g.visW * 0.5,
        h: g.visH * 0.3,
        color: '#e11d48',
        fill: true,
      });
    });
    const out = await stampAnnotations(base, { elements }, robotoBytes());
    for (const [i, g] of geoPerPage.entries()) {
      const img = await renderVisual(out, i + 1, 1.5);
      const el = elements[i]!;
      const inside = inkFraction(img, el.x + el.w * 0.3, g.visH - el.y - el.h * 0.7, el.w * 0.4, el.h * 0.4, g.visW, g.visH);
      expect(inside, `page ${i + 1} box center inked`).toBeGreaterThan(0.9);
      // Far outside the box (top strip) stays clean on the blank page.
      const outside = inkFraction(img, 0, 0, g.visW, g.visH * 0.12, g.visW, g.visH);
      expect(outside, `page ${i + 1} outside clean`).toBeLessThan(0.02);
    }
  }, 120_000);

  it('filled ellipse: center inked, bounding-box corner clean, radii swap on rotated pages', async () => {
    const base = await buildFixture();
    const el: AnnotateElement = {
      kind: 'ellipse',
      page: 2, // /Rotate 90 — the swap path
      x: 100,
      y: 75,
      w: 200,
      h: 150,
      color: '#2563eb',
      fill: true,
    };
    const out = await stampAnnotations(base, { elements: [el] }, robotoBytes());
    const img = await renderVisual(out, 2, 1.5);
    // Visual box: x∈[100,300], y∈[75,225] of a 300×400 visual page. Center
    // window around (200,150); bounding-box corner probe at the top-left.
    const center = inkFraction(img, 180, 400 - 170, 40, 30, 300, 400);
    expect(center).toBeGreaterThan(0.9);
    const corner = inkFraction(img, 100, 400 - 225, 30, 25, 300, 400);
    expect(corner).toBeLessThan(0.05);
  }, 120_000);

  it('line draws the box diagonal (TL → BR) on a /Rotate 180 page', async () => {
    const base = await buildFixture();
    const el: AnnotateElement = { kind: 'line', page: 3, x: 50, y: 200, w: 300, h: -0 + 100, color: '#111111', size: 6 };
    const out = await stampAnnotations(base, { elements: [el] }, robotoBytes());
    const img = await renderVisual(out, 3, 1.5);
    // Diagonal TL(50,300) → BR(350,200); midpoint (200,250) visual bottom-up.
    const mid = inkFraction(img, 185, 300 - 250 - 15, 30, 30, 400, 300);
    expect(mid).toBeGreaterThan(0.15);
    // The anti-diagonal corners (BL, TR) are off the line and stay clean —
    // the TL/BR corners are the line's own endpoints.
    const bl = inkFraction(img, 50, 300 - 200 - 15, 25, 15, 400, 300);
    const tr = inkFraction(img, 325, 300 - 300, 25, 15, 400, 300);
    expect(bl).toBeLessThan(0.05);
    expect(tr).toBeLessThan(0.05);
  }, 120_000);

  it('VN text stamp: extractable on every rotation, inked in its visual box', async () => {
    const base = await buildFixture();
    const text = 'ĐỖ THỊ MINH 0123456789';
    const pages = [1, 2, 3, 4];
    const elements = pages.map((p) => ({
      kind: 'text' as const,
      page: p,
      x: 30,
      y: 260,
      w: 0,
      h: 0,
      size: 18,
      color: '#111111',
      text,
    }));
    const out = await stampAnnotations(base, { elements }, robotoBytes());

    const pdfjs = await pdfjsLegacy();
    const task = pdfjs.getDocument({ data: new Uint8Array(out), useSystemFonts: false });
    const doc = await task.promise;
    try {
      for (const p of pages) {
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        const joined = tc.items.map((i) => ('str' in i ? i.str : '')).join(' ');
        expect(joined.replace(/\s+/g, ' '), `page ${p} extraction`).toContain(text);
      }
    } finally {
      await task.destroy();
    }
    const img = await renderVisual(out, 2, 1.5); // rot 90 → visual 300×400
    expect(inkFraction(img, 30, 400 - 278, 150, 20, 300, 400)).toBeGreaterThan(0.2);
  }, 120_000);

  it('placement math: visualToPageSpace round-trips the matrix (spot checks)', async () => {
    const libDoc = await PDFDocument.load(await buildFixture(), { ignoreEncryption: true });
    const cropped = libDoc.getPage(4); // 0-based index 4 = page 5 (cropped, rot 90)
    const geom = visibleGeometry(cropped);
    expect(geom.visualWidth).toBe(200);
    expect(geom.visualHeight).toBe(250);
    // rot 90: visual BL → user right-bottom of the crop box; visual TR → user
    // left-top (lx = vh − vy, ly = vx, offset by the crop origin).
    const bl = visualToPageSpace(0, 0, geom);
    expect(bl.x).toBeCloseTo(300);
    expect(bl.y).toBeCloseTo(50);
    const topRight = visualToPageSpace(200, 250, geom);
    expect(topRight.x).toBeCloseTo(50);
    expect(topRight.y).toBeCloseTo(250);
  });

  it('overflow refuses with a typed error and encrypted input refuses', async () => {
    const base = await buildFixture();
    const err = await stampAnnotations(
      base,
      { elements: [{ kind: 'text', page: 1, x: 350, y: 100, w: 0, h: 0, size: 24, text: 'QUÁ DÀI ĐỂ VỪA KHÔNG GIAN TRANG' }] },
      robotoBytes(),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AnnotationRefusedError);

    const encrypted = await encryptPdf(base, 'user-pass', 'owner-pass');
    const err2 = await stampAnnotations(
      encrypted,
      { elements: [{ kind: 'rect', page: 1, x: 10, y: 10, w: 50, h: 50 }] },
      robotoBytes(),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err2).toBeInstanceOf(AnnotationRefusedError);
  }, 120_000);
});
