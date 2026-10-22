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
  PDFRawStream,
  StandardFonts,
  degrees,
  rgb,
} from 'pdf-lib';
import { unzlibSync } from 'fflate';
import * as fontkitStar from '@pdf-lib/fontkit';
import {
  NotOwnWatermarkError,
  WatermarkNotFoundError,
  removeWatermark,
  reverseOwnWatermark,
  stampWatermark,
} from '../src/engine/pdf-lib';

/*
 * Watermark removal engine (v0.8.1 phase 2) — the phase-1 spike corpus,
 * promoted to spec form. Fixture pairs (clean / stamped) are built INLINE
 * with the repo's Roboto subset exactly like temp/spikes/wm-removal/proto.mjs
 * (the GO harness); pdf.js legacy is the independent oracle. Clean = the
 * post-removal extraction profile (hint occurrences + full item multiset per
 * page) equals the CLEAN original's — C5's in-content copy legitimately
 * survives. standardFontDataUrl MUST be set or standard-font (Helvetica)
 * classes false-negative (spike finding).
 */
const ROOT = join(import.meta.dirname, '..');
const ROBOTO = join(ROOT, 'src', 'assets', 'fonts', 'Roboto-Regular.ttf');
const robotoBytes = () => new Uint8Array(readFileSync(ROBOTO));

const WM_TEXT = 'BẢN LƯU — NỘI BỘ';
const HELVETICA_WM = 'CONFIDENTIAL DRAFT';

// Same CJS interop dance as the engine's embedRobotoSubset.
const fontkit =
  'create' in fontkitStar ? fontkitStar : (fontkitStar as { default: typeof fontkitStar }).default;

// ---------- fixtures (proto ports; stampForeign embeds its OWN font instance
// and writes NO tag — the "foreign watermark" shape) ----------
async function buildClean(
  pages: number,
  opts: { sameStringInContent?: boolean } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(robotoBytes(), { subset: true });
  for (let p = 1; p <= pages; p += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Tài liệu kiểm thử — trang ${p}/${pages}`, { x: 48, y: 800, size: 13, font });
    for (let i = 0; i < 8; i += 1) {
      const line =
        opts.sameStringInContent && i === 3
          ? `Dòng ${i + 1}: ghi chú ${WM_TEXT} cho phép nội bộ cần giữ lại.`
          : `Dòng ${i + 1}: nội dung giữ lại — tổ hợp tiếng Việt ăâêôơư ạếềễự 0123456789.`;
      page.drawText(line, { x: 48, y: 770 - i * 16, size: 10, font });
    }
  }
  return doc.save({ useObjectStreams: false });
}

async function stampForeign(
  bytes: Uint8Array,
  opts: { rotated?: boolean; tiled?: boolean; helvetica?: boolean } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  doc.registerFontkit(fontkit);
  const font = opts.helvetica
    ? await doc.embedFont(StandardFonts.Helvetica)
    : await doc.embedFont(robotoBytes(), { subset: true });
  const text = opts.helvetica ? HELVETICA_WM : WM_TEXT;
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const draw = (x: number, y: number, rot: number) =>
      page.drawText(text, {
        x, y, size: 48, font, opacity: 0.15,
        rotate: degrees(rot), color: rgb(0.5, 0.5, 0.5),
      });
    if (opts.tiled) {
      for (let r = 0; r < 4; r += 1) for (let c = 0; c < 3; c += 1) draw(40 + c * 190, 80 + r * 210, 0);
    } else if (opts.rotated) {
      draw(80, 380, 45);
    } else {
      draw(width / 2 - 160, height / 2, 0);
    }
  }
  return doc.save({ useObjectStreams: false });
}

/** Resolved /Contents streams of a page (single stream or array; Contents
 * may nest arrays per the spec). */
function pageRawStreams(doc: PDFDocument, page: import('pdf-lib').PDFPage): PDFRawStream[] {
  const out: PDFRawStream[] = [];
  const walk = (o: unknown): void => {
    if (o instanceof PDFRawStream) out.push(o);
    else if (o instanceof PDFArray)
      for (let i = 0; i < o.size(); i += 1) walk(doc.context.lookup(o.get(i)));
  };
  walk(doc.context.lookup(page.node.get(PDFName.of('Contents'))));
  return out;
}

/** DE-compresses every page content stream (stored variant — some producers
 * emit uncompressed streams; exercises streamOpsText's non-flate branch).
 * pdf-lib writes existing raw streams verbatim at save (only /Length is
 * recomputed via updateDict), so the stored shape survives the round trip. */
async function storeAllPages(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  for (const page of doc.getPages()) {
    for (const s of pageRawStreams(doc, page)) {
      if (String(s.dict.get(PDFName.of('Filter')) ?? '') !== '/FlateDecode') continue; // already stored
      (s as { contents: Uint8Array }).contents = unzlibSync(s.contents); // readonly in .d.ts only
      s.dict.delete(PDFName.of('Filter'));
    }
  }
  return doc.save({ useObjectStreams: false });
}

/** Engine stamp (writes the pdftoolkit-wm ownership tag). */
async function stampOwn(bytes: Uint8Array): Promise<Uint8Array> {
  return stampWatermark(
    bytes,
    {
      mode: 'text',
      text: WM_TEXT,
      fontSize: 48,
      opacity: 0.15,
      rotation: 0,
      position: 'center',
      offsetX: 0,
      offsetY: 0,
    },
    robotoBytes(),
  );
}

// ---------- pdf.js oracle (proto's exact wiring) ----------
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
    data: bytes.slice(),
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
const multiset = (arr: string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const s of arr) m.set(s, (m.get(s) ?? 0) + 1);
  return m;
};
const occurrences = (page: string[], hint: string) =>
  page.filter((s) => norm(s).includes(norm(hint))).length;

/** Spike oracle: hint occurrences restored to the clean profile AND every
 * clean-original item still present (multiset per page) — zero damage. */
async function expectRestoredToClean(out: Uint8Array, clean: Uint8Array, hint: string): Promise<void> {
  const [after, cleanEx] = await Promise.all([extractPerPage(out), extractPerPage(clean)]);
  expect(after).toHaveLength(cleanEx.length);
  for (const [i, pg] of after.entries()) {
    expect(occurrences(pg, hint), `page ${i + 1} hint occurrences`).toBe(
      occurrences(cleanEx[i] ?? [], hint),
    );
  }
  for (const [i, pg] of cleanEx.entries()) {
    const want = multiset(pg.map(norm));
    const got = multiset((after[i] ?? []).map(norm));
    for (const [s, n] of want) {
      expect(got.get(s) ?? 0, `page ${i + 1} lost "${s.slice(0, 40)}"`).toBeGreaterThanOrEqual(n);
    }
  }
}

describe('watermark removal (spike corpus, pdf.js oracle)', () => {
  it(
    '(1) engine-stamped (tagged) → reverseOwnWatermark → equals the clean original',
    async () => {
      const clean = await buildClean(3);
      const out = await reverseOwnWatermark(await stampOwn(clean));
      await expectRestoredToClean(out, clean, WM_TEXT);
    },
    120_000,
  );

  it(
    '(2) foreign stamp (separate embed instance, no tag) → removeWatermark(hint) → equals the clean original',
    async () => {
      const clean = await buildClean(3);
      const out = await removeWatermark(await stampForeign(clean), { hint: WM_TEXT });
      await expectRestoredToClean(out, clean, WM_TEXT);
    },
    120_000,
  );

  it(
    '(3) C5 same-string-in-content: the content copy survives, the stamp goes',
    async () => {
      const clean = await buildClean(3, { sameStringInContent: true });
      expect(occurrences((await extractPerPage(clean))[0] ?? [], WM_TEXT)).toBeGreaterThan(0);
      const out = await removeWatermark(await stampForeign(clean), { hint: WM_TEXT });
      await expectRestoredToClean(out, clean, WM_TEXT);
    },
    120_000,
  );

  it('(4) nothing matches → typed WatermarkNotFoundError, output never produced', async () => {
    const clean = await buildClean(2);
    const err = await removeWatermark(clean, { hint: 'KHÔNG TỒN TẠI' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WatermarkNotFoundError);
    expect((err as Error).name).toBe('WatermarkNotFoundError');
  });

  it('(5) untagged file → reverseOwnWatermark → typed NotOwnWatermarkError', async () => {
    const clean = await buildClean(2);
    const err = await reverseOwnWatermark(clean).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(NotOwnWatermarkError);
    expect((err as Error).name).toBe('NotOwnWatermarkError');
  });

  it(
    '(6) tiled watermark (12 tiles × 3 pages) fully removed',
    async () => {
      const clean = await buildClean(3);
      const out = await removeWatermark(await stampForeign(clean, { tiled: true }), { hint: WM_TEXT });
      await expectRestoredToClean(out, clean, WM_TEXT);
    },
    120_000,
  );

  it('(7) the stamp-time ownership tag is valid JSON and round-trips', async () => {
    const clean = await buildClean(3);
    const stamped = await stampOwn(clean);
    const doc = await PDFDocument.load(stamped);
    const info = doc.context.lookup(doc.context.trailerInfo.Info);
    expect(info).toBeInstanceOf(PDFDict);
    const raw = (info as PDFDict).lookupMaybe(PDFName.of('pdftoolkit-wm'), PDFHexString);
    expect(raw).toBeTruthy();
    const tag = JSON.parse(raw!.decodeText()) as Record<string, unknown>;
    expect(tag).toEqual({
      v: 1,
      mode: 'text',
      text: WM_TEXT,
      size: 48,
      tiled: false,
      pages: [1, 2, 3],
    });
    // And the tag is what makes (1) exact: reversal deletes it afterwards.
    const reversed = await reverseOwnWatermark(stamped);
    const doc2 = await PDFDocument.load(reversed);
    const info2 = doc2.context.lookup(doc2.context.trailerInfo.Info);
    expect((info2 as PDFDict | undefined)?.lookupMaybe(PDFName.of('pdftoolkit-wm'), PDFHexString)).toBeUndefined();
  });

  it(
    '(8) C6 standard-font watermark (Helvetica literal) removed via the semantic path',
    async () => {
      const clean = await buildClean(3);
      const out = await removeWatermark(await stampForeign(clean, { helvetica: true }), {
        hint: HELVETICA_WM,
      });
      await expectRestoredToClean(out, clean, HELVETICA_WM);
    },
    120_000,
  );

  it(
    '(9) stream shapes: the corpus IS /FlateDecode (decode path), and stored (uncompressed) streams match too',
    async () => {
      const clean = await buildClean(3);
      const stamped = await stampForeign(clean, { rotated: true });
      // Vacuity guard: pdf-lib-authored saves carry /Filter /FlateDecode with
      // zlib-wrapped contents — every case above runs the unzlibSync path.
      const guard = await PDFDocument.load(stamped);
      let flate = 0;
      for (const page of guard.getPages()) {
        for (const s of pageRawStreams(guard, page)) {
          if (String(s.dict.get(PDFName.of('Filter')) ?? '') === '/FlateDecode') flate += 1;
        }
      }
      expect(flate).toBeGreaterThanOrEqual(6); // 3 pages x (content + stamp)
      // Stored variant — the non-flate branch of streamOpsText.
      const out = await removeWatermark(await storeAllPages(stamped), { hint: WM_TEXT });
      await expectRestoredToClean(out, clean, WM_TEXT);
    },
    120_000,
  );
});
