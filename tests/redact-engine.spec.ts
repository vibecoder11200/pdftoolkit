import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  StandardFonts,
} from 'pdf-lib';
import {
  RedactRefusedError,
  redactCensus,
  redactFinalize,
  redactRasterScale,
  type RedactRect,
} from '../src/engine/pdf-lib';
import { deflateSync } from 'node:zlib';
import * as fontkitStar from '@pdf-lib/fontkit';

/*
 * Redact engine (v0.9.0 phase 2) — the GO spike corpus, promoted to spec form
 * (watermark-removal.spec.ts pattern: inline fixtures + pdf.js oracle).
 * redactFinalize is the ONLY deliver-capable op; every spec below drives it
 * (never the internal primitives) so the orphan rule is exercised exactly as
 * production will run it.
 */
const ROOT = join(import.meta.dirname, '..');
const ROBOTO = join(ROOT, 'src', 'assets', 'fonts', 'Roboto-Regular.ttf');
const robotoBytes = () => new Uint8Array(readFileSync(ROBOTO));

const fontkit =
  'create' in fontkitStar ? fontkitStar : (fontkitStar as { default: typeof fontkitStar }).default;

const SECRET = 'SECRET-007-ALPHA';
const SECRET_VN = 'BÍ MẬT 7431';

// ---------- fixtures ----------
async function bodyDoc(pages: number) {
  const doc = await PDFDocument.create();
  doc.setTitle('pdftoolkit-redact-spec');
  doc.setCreator('pdftoolkit-spec');
  doc.registerFontkit(fontkit);
  const roboto = await doc.embedFont(robotoBytes(), { subset: true });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const made: { page: import('pdf-lib').PDFPage; roboto: import('pdf-lib').PDFFont; helv: import('pdf-lib').PDFFont }[] = [];
  for (let p = 1; p <= pages; p += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Hồ sơ kiểm thử — trang ${p}/${pages}`, { x: 48, y: 800, size: 12, font: roboto });
    for (let i = 0; i < 7; i += 1) {
      page.drawText(`Dòng ${i + 1}: nội dung phải giữ nguyên — ăâêôơư 0123456789.`, {
        x: 48, y: 756 - i * 44, size: 10, font: roboto,
      });
    }
    // Helvetica registered on every page (raw-op fixtures reference it)
    page.drawText('.', { x: 6, y: 6, size: 6, font: helv });
    made.push({ page, roboto, helv });
  }
  return { doc, made };
}

/** Replaces a page's /Contents with raw operators (Helvetica name resolved). */
function replaceOps(doc: PDFDocument, page: import('pdf-lib').PDFPage, helv: import('pdf-lib').PDFFont, ops: string[]): void {
  const text = ops.join('\n');
  const bytes = Buffer.from(text, 'latin1');
  const stream = PDFRawStream.of(
    doc.context.obj({ Length: bytes.length, Filter: PDFName.of('FlateDecode') }),
    new Uint8Array(deflateSync(bytes)),
  );
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  void helv;
}

// Box shape mirrors the phase-1 calibration (descent 0.3·size below the
// baseline, ascent 0.85·size above) — the walker's estimated show box spans
// baseline−0.25s..baseline+0.85s, so a tighter rect would refuse the page.
const rectAround = (font: import('pdf-lib').PDFFont, text: string, x: number, baseline: number, size: number): RedactRect => ({
  x: x - 3,
  y: baseline - 0.3 * size - 1,
  w: font.widthOfTextAtSize(text, size) + 6,
  h: 1.15 * size + 2,
});

// ---------- pdf.js oracle (wm-removal pattern) ----------
let pdfjsMod: typeof import('pdfjs-dist') | null = null;
async function pdfjsLegacy(): Promise<typeof import('pdfjs-dist')> {
  pdfjsMod ??= (await import(
    pathToFileURL(join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href
  )) as typeof import('pdfjs-dist');
  return pdfjsMod;
}
async function extractPerPage(bytes: Uint8Array): Promise<string[][]> {
  const pdfjs = await pdfjsLegacy();
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    standardFontDataUrl: pathToFileURL(`${join(ROOT, 'node_modules/pdfjs-dist/standard_fonts')}/`).href,
  });
  const doc = await task.promise;
  const perPage: string[][] = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    perPage.push(tc.items.map((i) => ('str' in i ? String(i.str) : '')));
  }
  await task.destroy();
  return perPage;
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** RESIDUE + DAMAGE leg: on `redactedPages` no extracted item may still be the
 * secret (string-level); on `keepPages` every original item must survive. */
async function expectClean(out: Uint8Array, original: Uint8Array, redactedPages: number[], keepPages: number[], secret: string): Promise<void> {
  const [after, before] = await Promise.all([extractPerPage(out), extractPerPage(original)]);
  for (const p of redactedPages) {
    const joined = (after[p - 1] ?? []).map(norm).join(' ');
    expect(joined.includes(secret), `page ${p} still carries the secret`).toBe(false);
  }
  for (const p of keepPages) {
    const want = new Set((before[p - 1] ?? []).map(norm));
    for (const item of after[p - 1] ?? []) expect(want.has(norm(item)), `page ${p} lost "${norm(item).slice(0, 30)}"`).toBe(true);
  }
}

describe('redact engine (redactFinalize, spike corpus promoted)', () => {
  it('(1) F1 single-Tj surgical: secret line removed, body intact', async () => {
    const { doc, made } = await bodyDoc(3);
    made[1].page.drawText(SECRET_VN, { x: 60, y: 400, size: 14, font: made[1].roboto });
    const original = await doc.save({ useObjectStreams: false });
    const result = await redactFinalize(original, {
      secrets: [SECRET_VN],
      surgical: [{ page: 2, rects: [rectAround(made[1].roboto, SECRET_VN, 60, 400, 14)] }],
    });
    expect(result.removedBlocks).toBe(1);
    await expectClean(result.bytes, original, [2], [1, 3], SECRET_VN);
  }, 120_000);

  it('(2) F2 TJ-array surgical: secret assembled across array elements', async () => {
    const { doc, made } = await bodyDoc(2);
    const { page, helv } = made[1];
    replaceOps(doc, page, helv, [
      `BT /${helv.name} 12 Tf 60 480 Td [(SE) 20 (CR) 20 (ET-0) 20 (07-AL) 20 (PHA)] TJ ET`,
      `BT /${helv.name} 12 Tf 60 520 Td [(Noise line) 5 (keep)] TJ ET`,
    ]);
    const original = await doc.save({ useObjectStreams: false });
    const result = await redactFinalize(original, {
      secrets: [SECRET],
      surgical: [{ page: 2, rects: [{ x: 57, y: 474, w: 125, h: 20 }] }],
    });
    expect(result.removedBlocks).toBe(1);
    await expectClean(result.bytes, original, [2], [1], SECRET);
  }, 120_000);

  it('(3) F3 hex operand + octal-escaped literal: both blocks removed', async () => {
    const { doc, made } = await bodyDoc(2);
    const { page, helv } = made[1];
    const hexOps = Buffer.from(SECRET, 'latin1').toString('hex').toUpperCase();
    replaceOps(doc, page, helv, [
      `BT /${helv.name} 12 Tf 60 480 Td <${hexOps}> Tj ET`,
      `BT /${helv.name} 12 Tf 60 440 Td (\\123\\105CRET-007-ALPHA) Tj ET`,
    ]);
    const original = await doc.save({ useObjectStreams: false });
    const result = await redactFinalize(original, {
      secrets: [SECRET],
      surgical: [{ page: 2, rects: [{ x: 57, y: 474, w: 126, h: 20 }, { x: 57, y: 434, w: 126, h: 20 }] }],
    });
    expect(result.removedBlocks).toBe(2);
    await expectClean(result.bytes, original, [2], [1], SECRET);
  }, 120_000);

  it('(4) F1b partial-block probe: rect over one word refuses, output untouched', async () => {
    const { doc, made } = await bodyDoc(1);
    const line = `Mã tham chiếu: ${SECRET} hết hiệu lực`;
    made[0].page.drawText(line, { x: 60, y: 400, size: 12, font: made[0].roboto });
    const original = await doc.save({ useObjectStreams: false });
    const pre = 60 + made[0].roboto.widthOfTextAtSize('Mã tham chiếu: ', 12);
    const err = await redactFinalize(original, {
      secrets: [SECRET],
      surgical: [{ page: 1, rects: [{ x: pre - 1, y: 400 - 0.3 * 12 - 1, w: made[0].roboto.widthOfTextAtSize(SECRET, 12) + 2, h: 1.15 * 12 + 2 }] }],
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RedactRefusedError);
    expect((err as Error).name).toBe('RedactRefusedError');
  }, 120_000);

  it('(5) census-flagged page (ActualText + 3 Tr) refuses surgical, accepts raster', async () => {
    const { doc, made } = await bodyDoc(2);
    const { page, helv } = made[1];
    replaceOps(doc, page, helv, [
      `BT /${helv.name} 12 Tf 60 480 Td (marked content) Tj ET`,
      `/Span <</ActualText (${SECRET})>> BDC EMC`,
      `BT /${helv.name} 12 Tf 3 Tr 60 440 Td (${SECRET}) Tj ET`,
    ]);
    const original = await doc.save({ useObjectStreams: false });
    // surgical-only → refused
    const refused = await redactFinalize(original, {
      secrets: [SECRET],
      surgical: [{ page: 2, rects: [{ x: 57, y: 470, w: 300, h: 60 }] }],
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(RedactRefusedError);
    // census recalls both marker kinds
    const census = await redactCensus(original);
    const p2 = census.pages.find((p) => p.page === 2);
    expect(p2?.kinds).toContain('actualtext');
    expect(p2?.kinds).toContain('tr3');
    // raster path: render + paint + finalize (node-side stand-in for the wrapper)
    const jpeg = await renderPageWithRects(original, 2, [{ x: 40, y: 420, w: 500, h: 90 }]);
    const result = await redactFinalize(original, {
      secrets: [SECRET],
      raster: [{ page: 2, jpeg }],
    });
    expect(result.rasterPages).toEqual([2]);
    await expectClean(result.bytes, original, [2], [1], SECRET);
  }, 180_000);

  it('(6) F10 scoping: page-3 duplicate survives, run still verifies', async () => {
    const { doc, made } = await bodyDoc(3);
    made[0].page.drawText(SECRET_VN, { x: 60, y: 400, size: 14, font: made[0].roboto });
    made[2].page.drawText(SECRET_VN, { x: 60, y: 400, size: 14, font: made[2].roboto });
    const original = await doc.save({ useObjectStreams: false });
    const result = await redactFinalize(original, {
      secrets: [SECRET_VN],
      surgical: [{ page: 1, rects: [rectAround(made[0].roboto, SECRET_VN, 60, 400, 14)] }],
    });
    await expectClean(result.bytes, original, [1], [3], SECRET_VN);
  }, 120_000);

  it('(7) F12 doc channels: scrub-on-match removes every channel, body intact', async () => {
    const { doc } = await bodyDoc(1);
    const ctx = doc.context;
    doc.setAuthor(`Người giữ: ${SECRET}`);
    doc.setSubject(`Chủ đề ${SECRET_VN}`);
    const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${SECRET}</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const xmpBytes = Buffer.from(xmp, 'utf8');
    doc.catalog.set(
      PDFName.of('Metadata'),
      ctx.register(PDFRawStream.of(ctx.obj({ Length: xmpBytes.length, Type: PDFName.of('Metadata'), Subtype: PDFName.of('XML') }), new Uint8Array(xmpBytes))),
    );
    const outlineItem = ctx.obj({ Title: PDFHexString.fromText(`Mục lục ${SECRET_VN}`) });
    const outlinesRef = ctx.register(
      ctx.obj({ Type: PDFName.of('Outlines'), First: ctx.register(outlineItem), Last: ctx.register(outlineItem), Count: PDFNumber.of(1) }),
    );
    outlineItem.set(PDFName.of('Parent'), outlinesRef);
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
    const jsAction = ctx.register(ctx.obj({ S: PDFName.of('JavaScript'), JS: PDFString.of(`app.alert("${SECRET}")`) }));
    const efStream = PDFRawStream.of(ctx.obj({ Length: SECRET.length, Type: PDFName.of('EmbeddedFile') }), new Uint8Array(Buffer.from(SECRET, 'latin1')));
    const filespec = ctx.register(ctx.obj({
      Type: PDFName.of('Filespec'), F: PDFString.of('secret.txt'), UF: PDFHexString.fromText('secret.txt'),
      EF: ctx.obj({ F: ctx.register(efStream), UF: ctx.register(efStream) }),
    }));
    doc.catalog.set(PDFName.of('Names'), ctx.obj({
      JavaScript: ctx.obj({ Names: ctx.obj([PDFString.of(`két-xuất-${SECRET}`), jsAction]) }),
      EmbeddedFiles: ctx.obj({ Names: ctx.obj([PDFString.of(`tệp-${SECRET}.txt`), filespec]) }),
    }));
    const fieldRef = ctx.register(ctx.obj({
      FT: PDFName.of('Tx'), T: PDFString.of('SecretField'), V: PDFHexString.fromText(SECRET),
      Rect: ctx.obj([100, 100, 260, 120].map((n) => PDFNumber.of(n))),
    }));
    doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: ctx.obj([fieldRef]) }));
    const original = await doc.save({ useObjectStreams: false });

    const census = await redactCensus(original);
    expect(census.docChannels).toEqual(
      expect.arrayContaining(['info:Author', 'info:Subject', 'xmp', 'outlines', 'names:JavaScript', 'names:EmbeddedFiles', 'acroform:V']),
    );

    const result = await redactFinalize(original, { secrets: [SECRET, SECRET_VN] });
    const channels = new Set(result.scrubActions.map((a) => a.channel));
    for (const c of ['info:Author', 'info:Subject', 'xmp', 'outlines', 'names:JavaScript', 'names:EmbeddedFiles', 'acroform:V']) {
      expect(channels.has(c), `channel ${c} not scrubbed`).toBe(true);
    }
    // reloaded output: channels actually gone
    const outDoc = await PDFDocument.load(result.bytes, { ignoreEncryption: true });
    const info = outDoc.context.lookup(outDoc.context.trailerInfo.Info) as PDFDict;
    expect(info.lookupMaybe(PDFName.of('Author'), PDFString)).toBeUndefined();
    const acro = outDoc.context.lookup(outDoc.catalog.get(PDFName.of('AcroForm'))) as PDFDict;
    const fields = outDoc.context.lookup(acro.get(PDFName.of('Fields'))) as PDFArray;
    // the field SURVIVES with its value cleared (scrub clears /V, keeps the field)
    expect(fields.size()).toBe(1);
    const field0 = outDoc.context.lookup(fields.get(0)) as PDFDict;
    expect(field0.lookupMaybe(PDFName.of('V'), PDFHexString)).toBeUndefined();
    // body page intact
    await expectClean(result.bytes, original, [], [1], 'never-matches');
  }, 180_000);

  it('(8) F14 field-level widgets: overlapping one widget removes the field + both siblings', async () => {
    const { doc, made } = await bodyDoc(1);
    const page = made[0].page;
    const ctx = doc.context;
    const fieldDict = ctx.obj({ FT: PDFName.of('Tx'), T: PDFString.of('JointField'), V: PDFHexString.fromText(SECRET) });
    const fieldRef = ctx.register(fieldDict);
    const mkWidget = (y: number) =>
      ctx.register(ctx.obj({
        Type: PDFName.of('Annot'), Subtype: PDFName.of('Widget'), Parent: fieldRef,
        Rect: ctx.obj([60, y, 260, y + 24].map((n) => PDFNumber.of(n))),
      }));
    const w1 = mkWidget(360);
    const w2 = mkWidget(320);
    fieldDict.set(PDFName.of('Kids'), ctx.obj([w1, w2]));
    page.node.set(PDFName.of('Annots'), ctx.obj([w1, w2]));
    const original = await doc.save({ useObjectStreams: false });

    const census = await redactCensus(original);
    expect(census.pages[0]?.kinds).toContain('widget');

    // widget hit forces the raster tier — supply the raster page
    const jpeg = await renderPageWithRects(original, 1, [{ x: 40, y: 300, w: 300, h: 100 }]);
    const result = await redactFinalize(original, { secrets: [SECRET], raster: [{ page: 1, jpeg }] });
    const outDoc = await PDFDocument.load(result.bytes, { ignoreEncryption: true });
    const acro = outDoc.context.lookup(outDoc.catalog.get(PDFName.of('AcroForm'))) as PDFDict | undefined;
    if (acro) {
      const fields = outDoc.context.lookup(acro.get(PDFName.of('Fields'))) as PDFArray;
      expect(fields.size()).toBe(0);
    }
  }, 180_000);

  it('(9) signed input refuses before any mutation', async () => {
    const { doc } = await bodyDoc(1);
    const ctx = doc.context;
    const sigValue = ctx.register(ctx.obj({ ByteRange: ctx.obj([0, 1, 2, 3].map((n) => PDFNumber.of(n))), Contents: PDFHexString.fromText('sig') }));
    const fieldRef = ctx.register(ctx.obj({ FT: PDFName.of('Sig'), T: PDFString.of('Sig1'), V: sigValue }));
    doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: ctx.obj([fieldRef]) }));
    const original = await doc.save({ useObjectStreams: false });
    const err = await redactFinalize(original, {
      secrets: [SECRET],
      surgical: [{ page: 1, rects: [{ x: 50, y: 380, w: 200, h: 20 }] }],
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RedactRefusedError);
  }, 120_000);

  it('(10) vertical text (/Wmode 1) refuses', async () => {
    const { doc, made } = await bodyDoc(1);
    const ctx = doc.context;
    const vertFont = ctx.register(ctx.obj({
      Type: PDFName.of('Font'), Subtype: PDFName.of('Type0'), Basefont: PDFName.of('/Vertical-Font'), Wmode: PDFNumber.of(1),
    }));
    const res = doc.context.lookup(made[0].page.node.get(PDFName.of('Resources'))) as PDFDict;
    const fonts = doc.context.lookup(res.get(PDFName.of('Font'))) as PDFDict;
    fonts.set(PDFName.of('Vert'), vertFont);
    const original = await doc.save({ useObjectStreams: false });
    const census = await redactCensus(original);
    expect(census.pages[0]?.kinds).toContain('vertical-text');
    const err = await redactFinalize(original, {
      secrets: [SECRET],
      surgical: [{ page: 1, rects: [{ x: 50, y: 380, w: 200, h: 20 }] }],
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RedactRefusedError);
  }, 120_000);

  it('(11) damaged xref: fail-closed — verified bytes or typed refusal, never a leak', async () => {
    const { doc, made } = await bodyDoc(1);
    made[0].page.drawText(SECRET_VN, { x: 60, y: 400, size: 14, font: made[0].roboto });
    const good = await doc.save({ useObjectStreams: false });
    // corrupt a startxref offset digit — the wasm qpdf empirically escalates
    // most repairable damage to exit 2 (linearize.spec precedent)
    const marker = Buffer.from('startxref').indexOf('startxref') >= 0 ? 'startxref' : 'startxref';
    void marker;
    const tail = Buffer.from(good.slice(-64)).toString('latin1');
    const m = /startxref\s+(\d+)/.exec(tail);
    expect(m).toBeTruthy();
    const broken = good.slice();
    const offset = Number(m![1]);
    const digitPos = good.length - 64 + tail.indexOf(String(offset)) + (String(offset).length - 1);
    broken[digitPos] = broken[digitPos] === 0x30 ? 0x31 : 0x30; // flip one digit
    const outcome = await redactFinalize(broken, {
      secrets: [SECRET_VN],
      surgical: [{ page: 1, rects: [rectAround(made[0].roboto, SECRET_VN, 60, 400, 14)] }],
    }).then(
      (r) => r,
      (e: unknown) => e,
    );
    if (outcome instanceof Error) {
      // fail-closed at load or at the qpdf rewrite (typed refusal)
      expect(outcome).toBeInstanceOf(Error);
    } else {
      // the repair path succeeded (pdf-lib re-reads from the objects, qpdf
      // exit 3) — the delivered output must STILL verify clean
      const result = outcome as { bytes: Uint8Array };
      await expectClean(result.bytes, good, [1], [], SECRET_VN);
    }
  }, 180_000);

  it('(12) raster clamp formula: dpi + long-edge + pixel budget all bind', () => {
    // A4 at 150dpi → dpi-bound
    expect(redactRasterScale(595, 842, 150)).toBeCloseTo(150 / 72, 5);
    // poster: long-edge binds below dpi
    const poster = redactRasterScale(2384, 3370, 300);
    expect(poster).toBeCloseTo(Math.min(300 / 72, 4096 / 3370, Math.sqrt(4096 * 4096 / (2384 * 3370))), 5);
    // absurdly huge page: pixel budget binds
    const huge = redactRasterScale(20000, 28000, 600);
    expect(huge * 20000 * huge * 28000).toBeLessThanOrEqual(4096 * 4096 + 1);
  });

  it('(13) census recall over the phase-1 corpus (when generated)', async () => {
    const corpus = join(ROOT, 'tests/fixtures/redact/manifest.json');
    if (!readFileSyncSafe(corpus)) {
      console.warn('[redact-engine] corpus not generated — skipping recall spec');
      return;
    }
    const manifest = JSON.parse(readFileSync(corpus, 'utf8')) as {
      fixtures: { file: string; expectCensusPages: Record<string, string[]> }[];
    };
    for (const f of manifest.fixtures) {
      const bytes = new Uint8Array(readFileSync(join(ROOT, 'tests/fixtures/redact', f.file)));
      const census = await redactCensus(bytes);
      for (const [p1Str, kinds] of Object.entries(f.expectCensusPages)) {
        const got = census.pages.find((p) => p.page === Number(p1Str))?.kinds ?? [];
        for (const k of kinds) expect(got, `${f.file} p${p1Str} missed ${k}`).toContain(k);
      }
    }
  }, 300_000);
});

function readFileSyncSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Renders one page node-side and paints the rects BEFORE encode (finding 1) —
 * the same thing the phase-3 wrapper does on the worker/main boundary. */
async function renderPageWithRects(bytes: Uint8Array, p1: number, rects: RedactRect[]): Promise<Uint8Array> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const pdfjs = await pdfjsLegacy();
  const { visibleGeometry } = await import('../src/engine/pdf-lib');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    standardFontDataUrl: pathToFileURL(`${join(ROOT, 'node_modules/pdfjs-dist/standard_fonts')}/`).href,
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
    // the runtime key is lowercase `canvasFactory` (pdf.js v6 accepts it; the
    // published .d.ts names the class property differently)
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = await task.promise;
  const page = await doc.getPage(p1);
  // visual geometry via the engine (same math the wrapper will use)
  const libDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const geom = visibleGeometry(libDoc.getPage(p1 - 1));
  const scale = Math.min(2, 2400 / Math.max(geom.visualWidth, geom.visualHeight));
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    canvas,
    viewport: vp,
    annotationMode: 0,
    // napi's SKRSContext2D is API-compatible for pdf.js's use here
  } as unknown as Parameters<typeof page.render>[0]).promise;
  ctx.fillStyle = '#000000';
  for (const r of rects) {
    ctx.fillRect(r.x * scale, (geom.visualHeight - (r.y + r.h)) * scale, r.w * scale, r.h * scale);
  }
  const jpeg = await canvas.encode('jpeg', 0.9);
  await task.destroy();
  return new Uint8Array(jpeg);
}
