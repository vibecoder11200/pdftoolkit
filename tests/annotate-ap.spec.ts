import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, StandardFonts, degrees as pdfLibDegrees } from 'pdf-lib';
import { expose } from 'comlink';
import {
  AnnotationRefusedError,
  applyAnnotate,
  visibleGeometry,
  visualToPageSpace,
  type RedactRect,
} from '../src/engine/pdf-lib';
import { getPageTextItems, getTextItemRects } from '../src/engine/pdfjs';
import {
  EngineCrashedError,
  __setEngineWorkerSpawnForTests,
  engine,
} from '../src/engine/client';

/*
 * Annotate /AP (v0.9.0 phase 5) — the real-annotation contract for the
 * composed applyAnnotate op:
 *   - getPageTextItems (the ONE positional extraction path) is positional;
 *   - /QuadPoints corners are EXACTLY visualToPageSpace of the visual
 *     quads (item rects) — the rotation property, rot 0 and rot 90;
 *   - pdf.js renders the hand-built /AP streams (highlight tint + note
 *     glyphs land over the right band — the only viewer we can gate);
 *   - refusals fail CLOSED (a refused apply leaves the input bytes
 *     untouched, stamps included — never half-applied);
 *   - crash-injection through the worker seam: an in-flight apply rejects
 *     (EngineCrashedError) and an explicit retry from the ORIGINAL bytes
 *     yields exactly ONE annotation set — never a double-stamp.
 */

const ROOT = join(import.meta.dirname, '..');
const ROBOTO = join(ROOT, 'src', 'assets', 'fonts', 'Roboto-Regular.ttf');
const robotoBytes = () => new Uint8Array(readFileSync(ROBOTO));

const TARGET = 'PDFTOOLKIT HIGHLIGHT TARGET';

async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  // Page 1: rot 0; page 2: rot 90 (the visual/user swap trap). Same text
  // spot in USER space on both — the visual rects differ, the contract
  // (corners === visualToPageSpace(quads)) must hold on both.
  for (const rot of [0, 90] as const) {
    const page = doc.addPage([400, 300]);
    page.drawText(TARGET, { x: 40, y: 250, size: 14, font: helv });
    page.setRotation(pdfLibDegrees(rot));
  }
  return doc.save({ useObjectStreams: false });
}

/** Loads output and returns every annotation dict with /Subtype `sub`. */
async function findAnnots(
  bytes: Uint8Array,
  sub: 'Highlight' | 'FreeText',
): Promise<import('pdf-lib').PDFDict[]> {
  const doc = await PDFDocument.load(bytes);
  const out: import('pdf-lib').PDFDict[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj as import('pdf-lib').PDFDict;
    const st = dict.get?.(PDFName.of('Subtype'));
    if (st && st.toString() === `/${sub}`) out.push(dict);
  }
  return out;
}

function nums(arr: import('pdf-lib').PDFArray): number[] {
  return arr.asArray().map((v) => (v as import('pdf-lib').PDFNumber).asNumber());
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

/** Renders page p1 in VISUAL orientation, annotations on or off. */
async function renderVisual(bytes: Uint8Array, p1: number, withAnnots: boolean): Promise<Bitmap> {
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
    const vp = page.getViewport({ scale: 1.5 });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvas,
      viewport: vp,
      annotationMode: withAnnots ? 2 : 0,
    } as unknown as Parameters<typeof page.render>[0]).promise;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: img.data, width: img.width, height: img.height };
  } finally {
    await task.destroy();
  }
}

/** Fraction of pixels in a VISUAL rect (top-origin) matching a predicate. */
function probe(
  img: Bitmap,
  vx: number,
  vyTop: number,
  vw: number,
  vh: number,
  visW: number,
  visH: number,
  keep: (r: number, g: number, b: number) => boolean,
): number {
  const x0 = Math.max(0, Math.round((vx / visW) * img.width));
  const x1 = Math.min(img.width, Math.round(((vx + vw) / visW) * img.width));
  const y0 = Math.max(0, Math.round((vyTop / visH) * img.height));
  const y1 = Math.min(img.height, Math.round(((vyTop + vh) / visH) * img.height));
  let kept = 0;
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const o = (y * img.width + x) * 4;
      total += 1;
      if (keep(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!)) kept += 1;
    }
  }
  return total === 0 ? 0 : kept / total;
}

describe('getPageTextItems — the positional extraction path', () => {
  it('returns raw items with transforms on a plain page', async () => {
    const bytes = await buildFixture();
    const items = await getPageTextItems(bytes, 1);
    const target = items.find((i) => i.str === TARGET);
    expect(target).toBeDefined();
    expect(target!.transform[4]).toBeCloseTo(40, 0);
    expect(target!.transform[5]).toBeCloseTo(250, 0);
    expect(target!.height).toBeCloseTo(14, 0);
    expect(target!.width).toBeGreaterThan(100);
  });
});

describe('applyAnnotate — /QuadPoints math (rotation property)', () => {
  it('corners equal visualToPageSpace of the visual quads on rot 0 and rot 90', async () => {
    const base = await buildFixture();
    const quads1 = await getTextItemRects(base, 1);
    const quads2 = await getTextItemRects(base, 2);
    expect(quads1.length).toBeGreaterThan(0);
    expect(quads2.length).toBeGreaterThan(0);
    const out = await applyAnnotate(
      base,
      {
        annots: [
          { kind: 'highlight', page: 1, quads: quads1 },
          { kind: 'highlight', page: 2, quads: quads2 },
        ],
      },
      robotoBytes(),
    );
    const annots = await findAnnots(out, 'Highlight');
    expect(annots).toHaveLength(2);
    for (const [idx, dict] of annots.entries()) {
      const pageIdx = idx; // insertion order: page 1 then page 2
      const doc = await PDFDocument.load(out);
      const page = doc.getPage(pageIdx);
      const geom = visibleGeometry(page);
      const src = pageIdx === 0 ? quads1 : quads2;
      const qp = nums(dict.get(PDFName.of('QuadPoints')) as import('pdf-lib').PDFArray);
      expect(qp).toHaveLength(src.length * 8);
      for (const [qi, q] of src.entries()) {
        const want = {
          tl: visualToPageSpace(q.x, q.y + q.h, geom),
          tr: visualToPageSpace(q.x + q.w, q.y + q.h, geom),
          bl: visualToPageSpace(q.x, q.y, geom),
          br: visualToPageSpace(q.x + q.w, q.y, geom),
        };
        const got = qp.slice(qi * 8, qi * 8 + 8);
        // Spec order: TL, TR, BL, BR.
        expect(got[0]).toBeCloseTo(want.tl.x, 4);
        expect(got[1]).toBeCloseTo(want.tl.y, 4);
        expect(got[2]).toBeCloseTo(want.tr.x, 4);
        expect(got[3]).toBeCloseTo(want.tr.y, 4);
        expect(got[4]).toBeCloseTo(want.bl.x, 4);
        expect(got[5]).toBeCloseTo(want.bl.y, 4);
        expect(got[6]).toBeCloseTo(want.br.x, 4);
        expect(got[7]).toBeCloseTo(want.br.y, 4);
      }
      expect(dict.get(PDFName.of('Subtype'))!.toString()).toBe('/Highlight');
      expect((dict.get(PDFName.of('F')) as import('pdf-lib').PDFNumber).asNumber()).toBe(4);
      // /AP with a Form XObject must exist (portable rendering).
      const ap = dict.get(PDFName.of('AP')) as import('pdf-lib').PDFDict;
      const n = doc.context.lookup(ap.get(PDFName.of('N')));
      expect(n!.toString()).toContain('Subtype');
    }
  });

  it('pdf.js renders the highlight /AP over the right glyphs (tint probe)', async () => {
    const base = await buildFixture();
    const quads = await getTextItemRects(base, 1);
    const q = quads[0]!;
    const doc0 = await PDFDocument.load(base);
    const geom0 = visibleGeometry(doc0.getPage(0));
    const visW = geom0.visualWidth;
    const visH = geom0.visualHeight;
    const out = await applyAnnotate(
      base,
      { annots: [{ kind: 'highlight', page: 1, quads }] },
      robotoBytes(),
    );
    const on = await renderVisual(out, 1, true);
    const off = await renderVisual(out, 1, false);
    // Yellow #ffeb3b at 0.4 over white ≈ (255, 247, 177): blue channel drops.
    const tint = (r: number, g: number, b: number) => r > 235 && b < 220 && g > 230;
    const onFrac = probe(on, q.x - 1, visH - q.y - q.h + 1, q.w + 2, q.h - 2, visW, visH, tint);
    const offFrac = probe(off, q.x - 1, visH - q.y - q.h + 1, q.w + 2, q.h - 2, visW, visH, tint);
    expect(onFrac).toBeGreaterThan(0.5);
    expect(offFrac).toBeLessThan(0.02);
  });
});

describe('applyAnnotate — /FreeText note with /AP', () => {
  const NOTE: RedactRect = { x: 60, y: 100, w: 180, h: 46 };

  it('parses as FreeText, carries Contents, and its /AP renders', async () => {
    const base = await buildFixture();
    const text = 'Xin chào PDF Toolkit';
    const out = await applyAnnotate(
      base,
      { annots: [{ kind: 'note', page: 1, rect: NOTE, text }] },
      robotoBytes(),
    );
    const dicts = await findAnnots(out, 'FreeText');
    expect(dicts).toHaveLength(1);
    const contents = dicts[0]!.get(PDFName.of('Contents')) as import('pdf-lib').PDFHexString;
    expect(contents.decodeText()).toContain('Xin');
    expect(dicts[0]!.get(PDFName.of('AP'))).toBeDefined();

    // pdf.js oracle: getAnnotations sees it (pdf.js defers FreeText display
    // text to /RC and reports empty /Contents — the pdf-lib decode above is
    // the content gate); the AP paint probes below are the visual gate.
    const pdfjs = await pdfjsLegacy();
    const task = pdfjs.getDocument({ data: new Uint8Array(out) });
    const doc = await task.promise;
    try {
      const page = await doc.getPage(1);
      const annots = await page.getAnnotations();
      const ft = annots.find((a) => a.subtype === 'FreeText');
      expect(ft).toBeDefined();
      expect(ft!.rect).toHaveLength(4);
    } finally {
      await task.destroy();
    }
    const visW = 400;
    const visH = 300;
    const on = await renderVisual(out, 1, true);
    const fill = probe(
      on,
      NOTE.x + 4,
      visH - NOTE.y - NOTE.h + 4,
      NOTE.w - 8,
      NOTE.h - 8,
      visW,
      visH,
      (r, g, b) => r > 235 && b < 225 && g > 235,
    );
    const glyphs = probe(
      on,
      NOTE.x + 2,
      visH - NOTE.y - NOTE.h + 2,
      NOTE.w - 4,
      NOTE.h - 4,
      visW,
      visH,
      (r, g, b) => r < 120 && g < 120 && b < 120,
    );
    expect(fill).toBeGreaterThan(0.6);
    expect(glyphs).toBeGreaterThan(0.02);
    const off = await renderVisual(out, 1, false);
    const offFill = probe(
      off,
      NOTE.x + 4,
      visH - NOTE.y - NOTE.h + 4,
      NOTE.w - 8,
      NOTE.h - 8,
      visW,
      visH,
      (r, g, b) => r > 235 && b < 225 && g > 235,
    );
    expect(offFill).toBeLessThan(0.02);
  });

  it('mixed stamps + annots land in ONE save', async () => {
    const base = await buildFixture();
    const out = await applyAnnotate(
      base,
      {
        stamps: [
          { kind: 'rect', page: 1, x: 10, y: 10, w: 40, h: 20, color: '#e11d48', fill: true },
        ],
        annots: [
          {
            kind: 'note',
            page: 2,
            rect: { x: 50, y: 60, w: 140, h: 30 },
            text: 'rot90 note',
          },
        ],
      },
      robotoBytes(),
    );
    const hl = await findAnnots(out, 'Highlight');
    const ft = await findAnnots(out, 'FreeText');
    expect(hl).toHaveLength(0);
    expect(ft).toHaveLength(1);
    // The stamp is content-stream — assert via pdf.js visual ink at its spot.
    const on = await renderVisual(out, 1, true);
    const ink = probe(on, 12, 300 - 28, 36, 16, 400, 300, (r, g) => r > 150 && g < 120);
    expect(ink).toBeGreaterThan(0.5);
  });
});

describe('applyAnnotate — refusals fail closed', () => {
  it('an undrawable note character refuses the WHOLE apply (stamps included)', async () => {
    const base = await buildFixture();
    const stamps = [
      { kind: 'rect' as const, page: 1, x: 10, y: 10, w: 40, h: 20, color: '#e11d48', fill: true },
    ];
    await expect(
      applyAnnotate(
        base,
        {
          stamps,
          annots: [{ kind: 'note', page: 1, rect: NOTE_RECT, text: '中文 only' }],
        },
        robotoBytes(),
      ),
    ).rejects.toBeInstanceOf(AnnotationRefusedError);
    // Output untouched: re-apply with only the VALID stamp must produce a
    // doc with NO leftover partial state from the refused attempt.
    const out = await applyAnnotate(base, { stamps }, robotoBytes());
    expect(await findAnnots(out, 'FreeText')).toHaveLength(0);
    expect(await findAnnots(out, 'Highlight')).toHaveLength(0);
  });

  it('empty-text note, empty-quad highlight, out-of-range page refuse', async () => {
    const base = await buildFixture();
    await expect(
      applyAnnotate(
        base,
        { annots: [{ kind: 'note', page: 1, rect: NOTE_RECT, text: '   ' }] },
        robotoBytes(),
      ),
    ).rejects.toBeInstanceOf(AnnotationRefusedError);
    await expect(
      applyAnnotate(base, { annots: [{ kind: 'highlight', page: 1, quads: [] }] }, robotoBytes()),
    ).rejects.toBeInstanceOf(AnnotationRefusedError);
    await expect(
      applyAnnotate(
        base,
        {
          annots: [
            { kind: 'note', page: 9, rect: NOTE_RECT, text: 'hi' },
          ],
        },
        robotoBytes(),
      ),
    ).rejects.toBeInstanceOf(AnnotationRefusedError);
  });

  it('encrypted input refuses with the typed error', async () => {
    const { encryptPdf } = await import('../src/engine/qpdf');
    const base = await buildFixture();
    const enc = await encryptPdf(base, 'user-pass', 'owner-pass');
    await expect(
      applyAnnotate(
        enc,
        { annots: [{ kind: 'note', page: 1, rect: NOTE_RECT, text: 'hi' }] },
        robotoBytes(),
      ),
    ).rejects.toBeInstanceOf(AnnotationRefusedError);
  });
});

const NOTE_RECT: RedactRect = { x: 60, y: 100, w: 180, h: 46 };

/*
 * Crash injection (red-team mandate): the in-flight applyAnnotate rejects
 * with EngineCrashedError (client auto-respawns, NEVER auto-retries), and
 * an explicit retry from the ORIGINAL bytes yields exactly ONE annotation
 * set — the double-stamp scenario requires a partial first output, which
 * the single-op contract makes impossible.
 */
describe('applyAnnotate — crash-injected reject-and-restart (worker seam)', () => {
  interface Handle {
    worker: Worker;
    fireError(): void;
  }
  const spawned: Handle[] = [];
  __setEngineWorkerSpawnForTests(() => {
    const { port1, port2 } = new MessageChannel();
    const api =
      spawned.length === 0
        ? // Attempt 0: the worker dies mid-apply (op never settles).
          { applyAnnotate: (): Promise<never> => new Promise(() => undefined) }
        : // Respawn serves the REAL engine op.
          { applyAnnotate: (b: Uint8Array, o: Parameters<typeof engine.applyAnnotate>[1]) => applyAnnotate(b, o, robotoBytes()) };
    expose(api, port2);
    const w = {
      onerror: null as ((e: Event) => void) | null,
      onmessageerror: null as (() => void) | null,
      postMessage: (data: unknown, transfer?: Transferable[]) =>
        (port1 as { postMessage(d: unknown, t?: Transferable[]): void }).postMessage(data, transfer),
      addEventListener: (type: string, cb: EventListener) => port1.addEventListener(type, cb as EventListener),
      removeEventListener: (type: string, cb: EventListener) => port1.removeEventListener(type, cb as EventListener),
      start: () => port1.start(),
      terminate: () => {
        port1.close();
        port2.close();
      },
    };
    const handle: Handle = { worker: w as unknown as Worker, fireError: () => w.onerror?.(new Event('error')) };
    spawned.push(handle);
    return handle.worker;
  });
  afterAll(() => __setEngineWorkerSpawnForTests(null)); // restore production spawn

  it('mid-apply crash rejects; explicit retry from original bytes stamps ONCE', async () => {
    const base = await buildFixture();
    const annots = [{ kind: 'highlight' as const, page: 1, quads: await getTextItemRects(base, 1) }];

    const inflight = engine.applyAnnotate(base, { annots }, robotoBytes());
    // The client dials the worker after resolving the (explicit) font —
    // poll rather than a fixed sleep.
    for (let i = 0; i < 200 && spawned.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(spawned).toHaveLength(1);
    spawned[0].fireError();
    await expect(inflight).rejects.toBeInstanceOf(EngineCrashedError);

    // Explicit user retry — from the ORIGINAL bytes.
    const out = await engine.applyAnnotate(base, { annots }, robotoBytes());
    expect(spawned).toHaveLength(2); // lazy respawn happened
    const dicts = await findAnnots(out, 'Highlight');
    expect(dicts).toHaveLength(1);
    const qp = nums(dicts[0]!.get(PDFName.of('QuadPoints')) as import('pdf-lib').PDFArray);
    expect(qp).toHaveLength(8); // exactly one quad — not doubled
  });
});
