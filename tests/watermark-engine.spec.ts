import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  drawAngleFor,
  stampWatermark,
  visibleGeometry,
  visualToPageSpace,
} from '../src/engine/pdf-lib';
import { checkImageIntake, declaredImageDimensions } from '../src/lib/image-intake';

/*
 * Watermark engine (v0.8.0 phase 1): the rotation/CropBox placement transform
 * is the correctness core, verified here against pdf.js (legacy build, node)
 * as the INDEPENDENT oracle — pdf.js folds /Rotate + CropBox into its
 * viewport because it is the renderer, so a stamp that LOOKS right in every
 * viewer lands where pdf.js says it does. Direct engine imports, node-side,
 * exactly like tests/fill-form.spec.ts (finding 12 de-risked the legacy
 * build: 3 existing specs run it).
 */
const fx = (f: string) => join(import.meta.dirname, 'fixtures', f);
const ROBOTO = join(import.meta.dirname, '..', 'src', 'assets', 'fonts', 'Roboto-Regular.ttf');
const robotoBytes = () => new Uint8Array(readFileSync(ROBOTO));

// Keep in sync with tests/fixtures/gen.mjs GEOM_CONFIGS (order = page order).
const GEOM_CONFIGS = [
  { rotate: 0, crop: false },
  { rotate: 0, crop: true },
  { rotate: 90, crop: false },
  { rotate: 90, crop: true },
  { rotate: 180, crop: false },
  { rotate: 180, crop: true },
  { rotate: 270, crop: false },
  { rotate: 270, crop: true },
];

const POSITIONS = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;

async function pdfjsLegacy() {
  const require = createRequire(import.meta.url);
  return require('pdfjs-dist/legacy/build/pdf.mjs') as typeof import('pdfjs-dist');
}

interface ProbeDoc {
  getPageText(pageNumber: number): Promise<string>;
  findStamps(pageNumber: number, sentinel: string): Promise<{ x: number; y: number; angleDeg: number }[]>;
  pageMeta(pageNumber: number): Promise<{ view: number[]; rotate: number }>;
  close(): Promise<void>;
}

/** Device-space probe: positions are pdf.js viewport points (y DOWN from the
 * displayed top-left), angleDeg is the glyph direction in VISUAL coords
 * (y-up, CCW-positive). */
async function probeDoc(bytes: Uint8Array): Promise<ProbeDoc> {
  const legacy = await pdfjsLegacy();
  const task = legacy.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  return {
    async getPageText(pageNumber: number) {
      const page = await doc.getPage(pageNumber);
      const tc = await page.getTextContent();
      return tc.items.map((i) => ('str' in i ? String(i.str) : '')).join(' ');
    },
    async findStamps(pageNumber: number, sentinel: string) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const hits: { x: number; y: number; angleDeg: number }[] = [];
      for (const item of tc.items) {
        if (!('str' in item) || !String(item.str).includes(sentinel)) continue;
        const t = item.transform as number[];
        const [dx, dy] = viewport.convertToViewportPoint(t[4], t[5]);
        const [ex, ey] = viewport.convertToViewportPoint(t[4] + t[0], t[5] + t[1]);
        const vdx = ex - dx;
        const vdy = -(ey - dy); // visual y-up
        hits.push({ x: dx, y: dy, angleDeg: (Math.atan2(vdy, vdx) * 180) / Math.PI });
      }
      return hits;
    },
    async pageMeta(pageNumber: number) {
      const page = await doc.getPage(pageNumber);
      return { view: page.view as number[], rotate: page.rotate as number };
    },
    async close() {
      await task.destroy();
    },
  };
}

function displayedDimsOf(
  page: { view: number[]; rotate: number },
): { W: number; H: number; w: number; h: number } {
  const [x1, y1, x2, y2] = page.view;
  const w = x2 - x1;
  const h = y2 - y1;
  const rot = (((page.rotate % 360) + 360) % 360);
  const swap = rot === 90 || rot === 270;
  return { W: swap ? h : w, H: swap ? w : h, w, h };
}

function norm180(deg: number): number {
  let d = (((deg % 360) + 360) % 360);
  if (d > 180) d -= 360;
  return d;
}

describe('geometry primitives (pure)', () => {
  it('visibleGeometry reports the cropbox origin + swapped visual dims', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    expect(visibleGeometry(page)).toMatchObject({
      x: 0,
      y: 0,
      width: 595,
      height: 842,
      rotate: 0,
      visualWidth: 595,
      visualHeight: 842,
    });
    page.setRotation({ type: 'degrees', angle: 90 } as never);
    page.setCropBox(40, 60, 515, 722);
    expect(visibleGeometry(page)).toMatchObject({
      x: 40,
      y: 60,
      width: 515,
      height: 722,
      rotate: 90,
      visualWidth: 722,
      visualHeight: 515,
    });
  });

  it('visualToPageSpace maps displayed corners to the right user corners', () => {
    // Box origin (40,60), w=515, h=722. For /Rotate 90 the displayed
    // bottom-left shows the user-space BOTTOM-RIGHT corner (x1+w, y1).
    const geom90 = {
      x: 40, y: 60, width: 515, height: 722, rotate: 90 as const, visualWidth: 722, visualHeight: 515,
    };
    expect(visualToPageSpace(0, 0, geom90)).toEqual({ x: 555, y: 60 });
    expect(visualToPageSpace(722, 0, geom90)).toEqual({ x: 555, y: 782 });
    expect(visualToPageSpace(0, 515, geom90)).toEqual({ x: 40, y: 60 });
    expect(visualToPageSpace(722, 515, geom90)).toEqual({ x: 40, y: 782 });

    const geom180 = {
      x: 40, y: 60, width: 515, height: 722, rotate: 180 as const, visualWidth: 515, visualHeight: 722,
    };
    expect(visualToPageSpace(0, 0, geom180)).toEqual({ x: 555, y: 782 });
    expect(visualToPageSpace(515, 722, geom180)).toEqual({ x: 40, y: 60 });

    const geom270 = {
      x: 40, y: 60, width: 515, height: 722, rotate: 270 as const, visualWidth: 722, visualHeight: 515,
    };
    // /Rotate 270 (= 90° CCW display): displayed bottom-left shows the
    // original TOP-LEFT corner; bottom-right shows the original BOTTOM-LEFT.
    expect(visualToPageSpace(0, 0, geom270)).toEqual({ x: 40, y: 782 });
    expect(visualToPageSpace(722, 0, geom270)).toEqual({ x: 40, y: 60 });
    expect(visualToPageSpace(0, 515, geom270)).toEqual({ x: 555, y: 782 });
    expect(visualToPageSpace(722, 515, geom270)).toEqual({ x: 555, y: 60 });
  });

  it('drawAngleFor composes page rotation against the visual angle', () => {
    expect(drawAngleFor(0, 0)).toBe(0);
    expect(drawAngleFor(45, 0)).toBe(315); // 45° CW visual = −45 CCW
    expect(drawAngleFor(0, 90)).toBe(90); // draw upright-in-user; viewer turns it back
    expect(drawAngleFor(45, 90)).toBe(45);
    expect(drawAngleFor(90, 0)).toBe(270);
  });
});

describe('stampWatermark placement property matrix (pdf.js oracle)', () => {
  const geomBytes = () => new Uint8Array(readFileSync(fx('fixture-geom.pdf')));
  const FONT_SIZE = 24;

  it('every rotation × box × 9-grid cell lands in its displayed ninth with a horizontal glyph', async () => {
    for (const [k, pos] of POSITIONS.entries()) {
      const sentinel = `WMG${k}#`;
      const out = await stampWatermark(geomBytes(), {
        mode: 'text',
        text: sentinel,
        fontSize: FONT_SIZE,
        opacity: 1,
        rotation: 0,
        position: pos,
        offsetX: 0,
        offsetY: 0,
      }, robotoBytes());
      const probe = await probeDoc(out);
      try {
        for (const p of GEOM_CONFIGS.keys()) {
          const hits = await probe.findStamps(p + 1, sentinel);
          expect(hits.length, `${pos} page ${p + 1}`).toBe(1);
          const { W, H } = displayedDimsOf(await probe.pageMeta(p + 1));
          const row = pos.startsWith('top') ? 0 : pos === 'center' || pos.startsWith('middle') ? 1 : 2;
          const col = pos.endsWith('left') ? 0 : pos.endsWith('right') ? 2 : 1;
          // Ninth region in device coords (y down), slack absorbs the
          // ascent approximation and the measured-width centering.
          const slack = 12;
          const xMin = (col * W) / 3 - slack;
          const xMax = ((col + 1) * W) / 3 + slack;
          const yMin = (row * H) / 3 - slack;
          const yMax = ((row + 1) * H) / 3 + slack;
          const hit = hits[0];
          expect(
            hit.x >= xMin && hit.x <= xMax && hit.y >= yMin && hit.y <= yMax,
            `${pos} page ${p + 1}: stamp (${hit.x.toFixed(1)}, ${hit.y.toFixed(1)}) outside ninth x[${xMin.toFixed(0)},${xMax.toFixed(0)}] y[${yMin.toFixed(0)},${yMax.toFixed(0)}] of ${W}x${H}`,
          ).toBe(true);
          expect(norm180(hit.angleDeg), `${pos} page ${p + 1} angle`).toBeCloseTo(0, 0);
        }
      } finally {
        await probe.close();
      }
    }
  }, 120_000);

  it('visual rotation survives every page rotation (glyph angle oracle)', async () => {
    const sentinel = 'WMANG#';
    const out = await stampWatermark(geomBytes(), {
      mode: 'text',
      text: sentinel,
      fontSize: FONT_SIZE,
      opacity: 1,
      rotation: 45,
      position: 'center',
      offsetX: 0,
      offsetY: 0,
    }, robotoBytes());
    const probe = await probeDoc(out);
    try {
      for (const p of GEOM_CONFIGS.keys()) {
        const hits = await probe.findStamps(p + 1, sentinel);
        expect(hits.length, `page ${p + 1}`).toBe(1);
        // 45° CW visual = −45 CCW, regardless of the page's /Rotate.
        expect(norm180(hits[0].angleDeg), `page ${p + 1} angle`).toBeCloseTo(-45, 1);
      }
    } finally {
      await probe.close();
    }
  });

  it('stamps pages [2,4] only (scope oracle)', async () => {
    const sentinel = 'WMSCOPE#';
    const out = await stampWatermark(geomBytes(), {
      mode: 'text',
      text: sentinel,
      fontSize: FONT_SIZE,
      opacity: 1,
      rotation: 0,
      position: 'center',
      offsetX: 0,
      offsetY: 0,
      pages: [2, 4],
    }, robotoBytes());
    const probe = await probeDoc(out);
    try {
      for (const p of GEOM_CONFIGS.keys()) {
        const text = await probe.getPageText(p + 1);
        if (p + 1 === 2 || p + 1 === 4) expect(text).toContain(sentinel);
        else expect(text).not.toContain(sentinel);
      }
    } finally {
      await probe.close();
    }
  });

  it('out-of-range page numbers are filtered, never thrown (clamping contract)', async () => {
    const sentinel = 'WMCLAMP#';
    const bytes = new Uint8Array(readFileSync(fx('fixture-pagenums.pdf')));
    const out = await stampWatermark(bytes, {
      mode: 'text',
      text: sentinel,
      fontSize: FONT_SIZE,
      opacity: 1,
      rotation: 0,
      position: 'center',
      offsetX: 0,
      offsetY: 0,
      pages: [0, 3, 99, 3],
    }, robotoBytes());
    const probe = await probeDoc(out);
    try {
      for (const p of [1, 2, 3, 4, 5]) {
        const text = await probe.getPageText(p);
        if (p === 3) expect(text).toContain(sentinel);
        else expect(text).not.toContain(sentinel);
      }
    } finally {
      await probe.close();
    }
  });

  it('tiled on a /Rotate 90 page: ≥9 tiles covering all four visual quadrants', async () => {
    const sentinel = 'WMTILE#';
    const out = await stampWatermark(geomBytes(), {
      mode: 'text',
      text: sentinel,
      fontSize: FONT_SIZE,
      opacity: 1,
      rotation: 0,
      position: 'center',
      offsetX: 0,
      offsetY: 0,
      tiled: true,
      // 4 columns: on the displayed 842×595 page that yields 4×3 = 12 tiles
      // (3 columns would round to 2 rows = 6 — below the ≥9 criterion).
      tileColumns: 4,
      pages: [3], // /Rotate 90, MediaBox-only
    }, robotoBytes());
    const probe = await probeDoc(out);
    try {
      const { W, H } = displayedDimsOf(await probe.pageMeta(3));
      const hits = await probe.findStamps(3, sentinel);
      expect(hits.length).toBeGreaterThanOrEqual(9);
      const quadrants = { tl: 0, tr: 0, bl: 0, br: 0 };
      for (const hit of hits) {
        const vx = hit.x;
        const vy = H - hit.y; // visual y-up
        if (vx < W / 2 && vy > H / 2) quadrants.tl += 1;
        if (vx >= W / 2 && vy > H / 2) quadrants.tr += 1;
        if (vx < W / 2 && vy <= H / 2) quadrants.bl += 1;
        if (vx >= W / 2 && vy <= H / 2) quadrants.br += 1;
      }
      expect(quadrants.tl, 'top-left quadrant').toBeGreaterThan(0);
      expect(quadrants.tr, 'top-right quadrant').toBeGreaterThan(0);
      expect(quadrants.bl, 'bottom-left quadrant').toBeGreaterThan(0);
      expect(quadrants.br, 'bottom-right quadrant').toBeGreaterThan(0);
    } finally {
      await probe.close();
    }
  });

  it('Vietnamese diacritics extract byte-exact through the subset Roboto', async () => {
    const stamp = 'BẢN MẪU — nội bộ';
    const bytes = new Uint8Array(readFileSync(fx('fixture-small.pdf')));
    const out = await stampWatermark(bytes, {
      mode: 'text',
      text: stamp,
      fontSize: FONT_SIZE,
      opacity: 1,
      rotation: 0,
      position: 'center',
      offsetX: 0,
      offsetY: 0,
    }, robotoBytes());
    const probe = await probeDoc(out);
    try {
      expect(await probe.getPageText(1)).toContain(stamp);
    } finally {
      await probe.close();
    }
  });

  it('image watermark: output parses, grows, keeps the source text extractable', async () => {
    const bytes = new Uint8Array(readFileSync(fx('fixture-small.pdf')));
    const img = new Uint8Array(readFileSync(fx('fixture-photo.png')));
    const out = await stampWatermark(bytes, {
      mode: 'image',
      imageBytes: img,
      opacity: 1,
      scale: 0.5,
      position: 'center',
      offsetX: 0,
      offsetY: 0,
    }, robotoBytes());
    expect(out.byteLength).toBeGreaterThan(bytes.byteLength);
    const probe = await probeDoc(out);
    try {
      expect(await probe.getPageText(1)).toContain('PDFTOOLKIT FIXTURE small');
    } finally {
      await probe.close();
    }
  });

  it('refuses encrypted input with the typed error the UI routes to decrypt', async () => {
    const locked = new Uint8Array(readFileSync(fx('fixture-locked.pdf')));
    const textOpts = {
      mode: 'text' as const,
      text: 'x',
      fontSize: 24,
      opacity: 1,
      rotation: 0,
      position: 'center' as const,
      offsetX: 0,
      offsetY: 0,
    };
    // pdf-lib's EncryptedPDFError carries name "Error" at runtime (the CJS
    // class never assigns .name) — the /encrypted/i message is the reliable
    // carrier, which is why isEncryptedError checks BOTH (suggest.ts).
    await expect(stampWatermark(locked, textOpts, robotoBytes())).rejects.toThrow(
      /encrypted/i,
    );
  });
});

describe('image intake gate (decompression-bomb rejection)', () => {
  // Forged-header PNG: signature + IHDR declaring huge dimensions — only 29
  // bytes, no data chunks (the gate must reject from headers alone).
  function forgedPng(width: number, height: number): Uint8Array {
    const head = new Uint8Array(29);
    head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const dv = new DataView(head.buffer);
    dv.setUint32(8, 13); // IHDR data length
    head.set(Buffer.from('IHDR', 'ascii'), 12);
    dv.setUint32(16, width);
    dv.setUint32(20, height);
    head[24] = 8; // bit depth
    head[25] = 2; // truecolor
    return head; // CRC bytes stay zero — the gate reads headers only
  }

  it('rejects a forged PNG IHDR declaring 60000×60000 before any decode', () => {
    const verdict = checkImageIntake(forgedPng(60000, 60000));
    expect(verdict).toMatchObject({ ok: false, reason: 'too-many-pixels' });
  });

  it('accepts a real small PNG with its declared dimensions', () => {
    const real = new Uint8Array(readFileSync(fx('fixture-photo.png')));
    expect(checkImageIntake(real)).toEqual({ ok: true, format: 'png', width: 64, height: 48 });
    expect(declaredImageDimensions(real)).toEqual({ width: 64, height: 48, format: 'png' });
  });

  it('parses JPEG SOF dimensions and rejects oversized declarations', () => {
    // Synthetic JPEG: SOI + APP0-ish segment + SOF0 with 40000×30000.
    const bytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0x00)];
    bytes.push(0xff, 0xc0, 0x00, 0x11, 0x08);
    bytes.push((30000 >> 8) & 0xff, 30000 & 0xff);
    bytes.push((40000 >> 8) & 0xff, 40000 & 0xff);
    bytes.push(0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01);
    const verdict = checkImageIntake(new Uint8Array(bytes));
    expect(verdict).toMatchObject({ ok: false, reason: 'too-many-pixels' });
  });

  it('refuses non-image bytes as unsupported', () => {
    const pdfHead = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    expect(checkImageIntake(pdfHead)).toMatchObject({ ok: false, reason: 'unsupported' });
  });
});
