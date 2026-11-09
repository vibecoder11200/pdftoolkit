import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { annotateCompare, AnnotationRefusedError } from '../src/engine/pdf-lib';
import { coalesceCompareMarks, COMPARE_MARK_BUDGET, textDiffClauses } from '../src/lib/pdf-compare';
import { CompareMarkBudgetError } from '../src/engine/pdf-lib';
import type { CompareMark } from '../src/lib/pdf-compare';

/*
 * Compare annotated export (v0.11.0 phase 8a, plan 261109-1101).
 * - Pure units: coalesce run-merging + textDiffClauses (the lcsTokens
 *   wrapper — C6).
 * - Op boundary: fail-closed validation (NaN / out-of-range / page OOR),
 *   the 50k budget (S2 — checked BEFORE coalescing), and the signed-input
 *   refusal (shared docHasDigitalSignature posture).
 * - Oracle (F8): the watermark spec's principle — pdf.js is the renderer,
 *   so what it PAINTS is ground truth. The op draws rects (no glyphs), so
 *   the matrix pixel-probes a legacy pdf.js render: the mark's fraction box
 *   (device-space by definition) must carry the right tint on every
 *   rotated/cropped config in fixture-geom.pdf — the fraction→visual flip
 *   + geometry-primitive wiring is exactly the untested unit.
 */

const fx = (f: string) => join(import.meta.dirname, 'fixtures', f);
const geomBytes = () => new Uint8Array(readFileSync(fx('fixture-geom.pdf')));

/** A REAL ByteRange signature (/FT /Sig + /V + /ByteRange) — the loose
 * form-vn-signed.pdf fixture deliberately lacks /V (form tool R15 marker)
 * and must NOT trip the detector. */
async function signedBytes(): Promise<Uint8Array> {
  const { PDFDocument, PDFName, PDFString, PDFNumber, PDFHexString } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.addPage([300, 144]);
  const ctx = doc.context;
  const sigValue = ctx.register(ctx.obj({ ByteRange: ctx.obj([0, 1, 2, 3].map((n) => PDFNumber.of(n))), Contents: PDFHexString.fromText('sig') }));
  const fieldRef = ctx.register(ctx.obj({ FT: PDFName.of('Sig'), T: PDFString.of('Sig1'), V: sigValue }));
  doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: ctx.obj([fieldRef]) }));
  return doc.save({ useObjectStreams: false });
}

const mark = (over: Partial<CompareMark>): CompareMark => ({
  page: 1,
  nx: 0.25,
  nyTop: 0.25,
  nw: 0.2,
  nh: 0.06,
  kind: 'ins',
  ...over,
});

describe('coalesceCompareMarks (pure)', () => {
  it('merges adjacent same-row same-kind marks into band rects', () => {
    const out = coalesceCompareMarks([
      mark({ nx: 0.1, nyTop: 0.5, nw: 0.05, nh: 0.02, kind: 'ins' }),
      mark({ nx: 0.16, nyTop: 0.5, nw: 0.05, nh: 0.02, kind: 'ins' }),
      mark({ nx: 0.5, nyTop: 0.5, nw: 0.05, nh: 0.02, kind: 'ins' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.kind).toBe('ins');
    expect(out[0]!.nx).toBeCloseTo(0.1, 6);
    expect(out[0]!.nw).toBeCloseTo(0.11, 6);
    expect(out[0]!.nyTop).toBeCloseTo(0.5, 6);
    expect(out[0]!.nh).toBeCloseTo(0.02, 6);
    expect(out[1]!.nx).toBeCloseTo(0.5, 6);
  });

  it('never merges across pages, kinds, or different rows', () => {
    const out = coalesceCompareMarks([
      mark({ page: 1, nx: 0.1, kind: 'ins' }),
      mark({ page: 2, nx: 0.16, kind: 'ins' }),
      mark({ page: 1, nx: 0.22, kind: 'del' }),
      mark({ page: 1, nx: 0.28, nyTop: 0.6, kind: 'ins' }),
    ]);
    expect(out).toHaveLength(4);
  });

  it('absorbs vertically offset same-row marks into the union band', () => {
    const out = coalesceCompareMarks([
      mark({ nx: 0.1, nyTop: 0.5, nw: 0.1, nh: 0.02 }),
      mark({ nx: 0.21, nyTop: 0.505, nw: 0.1, nh: 0.025 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.nx).toBeCloseTo(0.1, 6);
    expect(out[0]!.nw).toBeCloseTo(0.21, 6);
    expect(out[0]!.nyTop).toBeCloseTo(0.5, 6);
    expect(out[0]!.nh).toBeCloseTo(0.03, 6); // union band: bottom = 0.505+0.025 = 0.53
  });

  it('is deterministic: same input, deep-equal output', () => {
    const input = [
      mark({ nx: 0.3, nyTop: 0.2 }),
      mark({ nx: 0.1, nyTop: 0.2 }),
      mark({ nx: 0.5, nyTop: 0.2 }),
    ];
    expect(coalesceCompareMarks(input)).toEqual(coalesceCompareMarks([...input].reverse()));
  });
});

describe('textDiffClauses (lcsTokens wrapper)', () => {
  it('joins adjacent same-kind runs into clause strings', () => {
    const out = textDiffClauses('the quick brown fox', 'the slow brown fox');
    expect(out).toEqual({ added: ['slow'], removed: ['quick'] });
  });

  it('multi-token runs join with spaces, order preserved', () => {
    const out = textDiffClauses('a b c d', 'a x y z d');
    expect(out).toEqual({ added: ['x y z'], removed: ['b c'] });
  });

  it('identical text yields no clauses', () => {
    expect(textDiffClauses('same words here', 'same   words here')).toEqual({ added: [], removed: [] });
  });
});

describe('annotateCompare boundary (fail closed)', () => {
  it('refuses non-finite fractions', async () => {
    await expect(annotateCompare(geomBytes(), [mark({ nx: Number.NaN })])).rejects.toBeInstanceOf(AnnotationRefusedError);
  });

  it('refuses fractions outside [0, 1]', async () => {
    await expect(annotateCompare(geomBytes(), [mark({ nw: 1.2 })])).rejects.toBeInstanceOf(AnnotationRefusedError);
    await expect(annotateCompare(geomBytes(), [mark({ nyTop: -0.01 })])).rejects.toBeInstanceOf(AnnotationRefusedError);
  });

  it('refuses out-of-range pages', async () => {
    await expect(annotateCompare(geomBytes(), [mark({ page: 9 })])).rejects.toBeInstanceOf(AnnotationRefusedError);
  });

  it('refuses above-budget input BEFORE coalescing (S2)', async () => {
    const flood: CompareMark[] = Array.from({ length: COMPARE_MARK_BUDGET + 1 }, (_, i) =>
      mark({ nx: (i % 1000) / 1000 }),
    );
    await expect(annotateCompare(geomBytes(), flood)).rejects.toBeInstanceOf(CompareMarkBudgetError);
  });

  it('refuses digitally signed input (shared posture)', async () => {
    await expect(annotateCompare(await signedBytes(), [mark({})])).rejects.toBeInstanceOf(AnnotationRefusedError);
  });
});

// ---------------------------------------------------------------------------
// Oracle property matrix (F8): render through legacy pdf.js into a
// @napi-rs/canvas and PIXEL-PROBE the fraction boxes — fractions are
// device-space by definition, so the expected box needs no rotation math;
// whatever the op drew must land there on every /Rotate × CropBox config.
// ---------------------------------------------------------------------------

const GEOM_CONFIGS = [
  { rotate: 0, crop: false },
  { rotate: 0, crop: true },
  { rotate: 90, crop: false },
  { rotate: 90, crop: true },
  { rotate: 180, crop: false },
  { rotate: 180, crop: true },
  { rotate: 270, crop: false },
  { rotate: 270, crop: true },
] as const;

async function renderPage(bytes: Uint8Array, pageNumber: number): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const require = createRequire(import.meta.url);
  const legacy = require('pdfjs-dist/legacy/build/pdf.mjs') as typeof import('pdfjs-dist');
  const { createCanvas } = await import('@napi-rs/canvas');
  const task = legacy.getDocument({ data: bytes.slice(), useSystemFonts: false });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
    return { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, w: canvas.width, h: canvas.height };
  } finally {
    await task.destroy();
  }
}

/** Peak channel dominance over the box region — opacity blending keeps the
 * tint subtle per-pixel; the MAX over the region is decisive (the del
 * strikethrough line is near-opaque at the band middle). */
function peakDominance(img: { data: Uint8ClampedArray; w: number; h: number }, x0: number, y0: number, x1: number, y1: number) {
  let maxGR = -255;
  let maxRG = -255;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(img.h, Math.ceil(y1)); y += 1) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(img.w, Math.ceil(x1)); x += 1) {
      const i = (y * img.w + x) * 4;
      const r = img.data[i]!;
      const g = img.data[i + 1]!;
      maxGR = Math.max(maxGR, g - r);
      maxRG = Math.max(maxRG, r - g);
    }
  }
  return { maxGR, maxRG };
}

describe('annotateCompare oracle matrix (pdf.js pixel probe)', () => {
  const INS: CompareMark = { page: 0, nx: 0.25, nyTop: 0.25, nw: 0.2, nh: 0.08, kind: 'ins' };
  const DEL: CompareMark = { page: 0, nx: 0.3, nyTop: 0.6, nw: 0.4, nh: 0.05, kind: 'del' };

  for (const [i, cfg] of GEOM_CONFIGS.entries()) {
    it(`config ${i} (/Rotate ${cfg.rotate}${cfg.crop ? ' + crop' : ''}): green lands in the ins box, red + line in the del box`, async () => {
      const bytes = await annotateCompare(geomBytes(), [
        { ...INS, page: i + 1 },
        { ...DEL, page: i + 1 },
      ]);
      const img = await renderPage(bytes, i + 1);
      const ins = peakDominance(img, INS.nx * img.w, INS.nyTop * img.h, (INS.nx + INS.nw) * img.w, (INS.nyTop + INS.nh) * img.h);
      expect(ins.maxGR, 'green tint inside the ins band').toBeGreaterThan(12);
      expect(ins.maxRG, 'no red bleed into the ins band').toBeLessThan(40);
      const del = peakDominance(img, DEL.nx * img.w, DEL.nyTop * img.h, (DEL.nx + DEL.nw) * img.w, (DEL.nyTop + DEL.nh) * img.h);
      expect(del.maxRG, 'red strikethrough inside the del band').toBeGreaterThan(60);
      // Outside both bands the page stays neutral: probe the mirrored band.
      const out = peakDominance(img, 0.05 * img.w, 0.05 * img.h, 0.15 * img.w, 0.15 * img.h);
      expect(Math.max(out.maxGR, out.maxRG), 'untouched region stays neutral').toBeLessThan(30);
    });
  }
});
