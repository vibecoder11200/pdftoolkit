// Phase 4b integration gates (plan v0.4.0, D7/D8/R8): REAL tesseract — no
// mocks. Unit coverage lives in tests/ocr.spec.ts (tesseract fully mocked);
// this file runs src/lib/ocr.ts end-to-end against the synced public/ OCR
// assets and the generated scan fixtures (tests/fixtures/gen.mjs).
//
// Self-skips when the fixtures or the OCR assets are missing (run
// `node tests/fixtures/gen.mjs` and `node scripts/sync-tessdata.mjs`).
//
// Node harness (the app's real runtime is a browser; these adaptations are
// the platform shim, reported in the phase journal):
// 1. `globalThis.caches` is an in-memory fake and `fetch` is shimmed to serve
//    BASE_URL-prefixed asset URLs (tessdata .gz, tesseract-core single-file
//    builds) with bytes read from disk — so ensureOcrAssets() runs REAL code
//    against the REAL synced assets.
// 2. tesseract.js is partially wrapped (vi.mock + importActual): createWorker
//    translates ocr.ts's browser worker options into node-worker equivalents
//    — the R14 same-origin URLs are meaningless to the node worker thread
//    (its getCore requires tesseract.js-core directly and its loadLanguage
//    reads `langPath` from the LOCAL FILESYSTEM, and the browser worker.min.js
//    bundle cannot run under worker_threads), so workerPath/corePath/
//    workerBlobURL are dropped (node defaults are used) and langPath points at
//    public/tessdata with cacheMethod 'none' (no disk cache). Everything else
//    — worker spawn, wasm core, traineddata, recognition, pdf output — is the
//    unmodified library.
// 3. Scan fixture pages are decoded with pdfjs-dist + @napi-rs/canvas (the
//    same rasterization pipeline as src/hooks/use-thumbnails) into JPEG bytes,
//    the OCR input the session accepts (node loadImage passes byte arrays
//    through; in the browser phase 5 feeds canvas/ImageData).
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import {
  CORE_ASSETS,
  OcrAbortedError,
  createOcrSession,
  ensureOcrAssets,
  foldSearchablePdfParts,
  mergeSearchablePdfParts,
  type OcrPageInput,
} from '../src/lib/ocr';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(ROOT, 'tests', 'fixtures');
const VN_EN_PDF = join(FIXTURES, 'ocr-scan-vn-en.pdf');
const SCAN12_PDF = join(FIXTURES, 'ocr-scan-12p.pdf');
const TESSDATA_DIR = join(ROOT, 'public', 'tessdata');
const CORE_DIR = join(ROOT, 'public', 'tesseract-core');

// In-memory scratch dir for the node worker (cacheMethod 'none' never writes
// to it — the path just keeps the library away from the process cwd).
const CACHE_DIR = mkdtempSync(join(tmpdir(), 'pdftoolkit-ocr-int-'));

const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

// Node platform adapter — see the file header. Everything except the option
// translation is the real tesseract.js (importActual).
vi.mock('tesseract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('tesseract.js')>();
  const createWorker = (
    langs: Parameters<typeof actual.createWorker>[0],
    oem: Parameters<typeof actual.createWorker>[1],
    options?: Parameters<typeof actual.createWorker>[2],
    config?: Parameters<typeof actual.createWorker>[3],
  ) => {
    const isNode = typeof process !== 'undefined' && process.versions?.node != null;
    if (!isNode) return actual.createWorker(langs, oem, options, config);
    // Drop the browser-specific paths (node defaults apply) and point the
    // language data at the synced public/ assets on disk. Relative same-origin
    // URLs are interpreted as filesystem paths by the node worker's
    // loadLanguage, so the R14 URL config cannot survive the translation.
    const { workerPath: _wp, corePath: _cp, workerBlobURL: _wb, ...rest } = options ?? {};
    void _wp;
    void _cp;
    void _wb;
    return actual.createWorker(
      langs,
      oem,
      { ...rest, langPath: TESSDATA_DIR, cachePath: CACHE_DIR, cacheMethod: 'none', gzip: true },
      config,
    );
  };
  return { ...actual, createWorker };
});

// Every URL the disk-backed fetch shim served (used by the asset test below).
const fetchCalls: string[] = [];

function installNodeAssetHarness(): void {
  const serve = (url: string): Uint8Array | null => {
    if (!url.startsWith(`${BASE}/`)) return null;
    const rel = url.slice(BASE.length + 1);
    if (rel.startsWith('tessdata/')) {
      return new Uint8Array(readFileSync(join(TESSDATA_DIR, rel.slice('tessdata/'.length))));
    }
    if (rel.startsWith('tesseract-core/')) {
      return new Uint8Array(readFileSync(join(CORE_DIR, rel.slice('tesseract-core/'.length))));
    }
    return null;
  };
  const store = new Map<string, Response>();
  vi.stubGlobal('caches', {
    open: async () => ({
      match: async (url: string) => store.get(url),
      put: async (url: string, response: Response) => {
        store.set(url, response);
      },
    }),
  });
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      const bytes = serve(url);
      fetchCalls.push(url);
      if (!bytes) return new Response(`harness miss: ${url}`, { status: 404 });
      return new Response(bytes, { status: 200 });
    },
  );
}

// Same pattern as tests/helpers/text-assert.ts, but for an arbitrary page —
// fold/merge order checks need text from the LAST page too.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const legacy = require('pdfjs-dist/legacy/build/pdf.mjs') as typeof import('pdfjs-dist');

async function getPageText(bytes: Uint8Array, pageNumber: number): Promise<string> {
  const loadingTask = legacy.getDocument({ data: bytes.slice() });
  const doc = await loadingTask.promise;
  try {
    const page = await doc.getPage(pageNumber);
    const tc = await page.getTextContent();
    return tc.items.map((i) => ('str' in i ? String(i.str) : '')).join(' ');
  } finally {
    await loadingTask.destroy();
  }
}

/** Render one page of a scan fixture to JPEG bytes at the given dpi. */
async function renderScanPage(scan: Uint8Array, pageNumber: number, dpi: number): Promise<Uint8Array> {
  const loadingTask = legacy.getDocument({ data: scan.slice() });
  const doc = await loadingTask.promise;
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
    }).promise;
    return new Uint8Array(await canvas.encode('jpeg', 0.95));
  } finally {
    await loadingTask.destroy();
  }
}

// Node harness adaptation (see file header, item 3): the node loadImage passes
// byte arrays straight through to the worker, so the JPEG raster is a valid
// page input at runtime even though OcrPageInput's union is browser-shaped.
const asPageInput = (bytes: Uint8Array): OcrPageInput => bytes as unknown as OcrPageInput;

/** OCR-assert normalizer: tesseract pads words with runs of spaces. */
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

const assetMissing = [
  ...CORE_ASSETS.map((f) => join(CORE_DIR, f.slice('tesseract-core/'.length))),
  join(TESSDATA_DIR, 'eng.traineddata.gz'),
  join(TESSDATA_DIR, 'vie.traineddata.gz'),
  VN_EN_PDF,
  SCAN12_PDF,
].filter((p) => !existsSync(p));

if (assetMissing.length > 0) {
  console.warn(
    `[ocr-integration] self-skipping — missing assets/fixtures:\n  ${assetMissing.join('\n  ')}\n` +
      '  Run: node scripts/sync-tessdata.mjs && node tests/fixtures/gen.mjs',
  );
}
const d = assetMissing.length === 0 ? describe : describe.skip;

beforeAll(() => {
  installNodeAssetHarness();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

d('ocr integration (real tesseract)', () => {
  it(
    'pins the real synced OCR assets through the disk-backed fetch shim',
    { timeout: 60_000 },
    async () => {
      const expected = [
        ...CORE_ASSETS.map((f) => `${BASE}/${f}`),
        `${BASE}/tessdata/vie.traineddata.gz`,
        `${BASE}/tessdata/eng.traineddata.gz`,
      ];

      await ensureOcrAssets('vie+eng');
      await ensureOcrAssets('vie+eng'); // second run: served from the cache store

      expect(fetchCalls).toEqual(expected);
    },
  );

  it(
    '2-page VN+EN scan → searchable PDF: pages, keywords, via mergeSearchablePdfParts (D7)',
    { timeout: 120_000 },
    async () => {
      const scan = new Uint8Array(readFileSync(VN_EN_PDF));

      const session = await createOcrSession({ langs: 'vie+eng' });
      const parts: Uint8Array[] = [];
      for (const n of [1, 2]) {
        parts.push(await session.recognizeToPdfPage(asPageInput(await renderScanPage(scan, n, 200))));
      }
      await session.dispose();

      const merged = await mergeSearchablePdfParts(parts);
      const doc = await PDFDocument.load(merged, { ignoreEncryption: false });
      expect(doc.getPageCount()).toBe(2);

      // EN keywords on page 1, VN diacritic keywords on page 2 (fixture text
      // is rendered by gen.mjs — keep the strings in sync). Keywords chosen
      // for OCR robustness: no inter-word punctuation noise (tesseract
      // occasionally inserts a spurious period at a wide word gap).
      const en = norm(await getPageText(merged, 1));
      expect(en).toContain('quarterly report');
      expect(en).toContain('42,518');
      expect(en).toContain('revenue up 12.4 percent');
      const vn = norm(await getPageText(merged, 2));
      expect(vn).toContain('đặng thị thu lĩnh');
      expect(vn).toContain('kế hoạch 2026');
      expect(vn).toContain('hà nội');
    },
  );

  it(
    'fold-merge over 12 OCR pages: valid 12-page output, order preserved, no duplication (R8)',
    { timeout: 120_000 },
    async () => {
      const scan = new Uint8Array(readFileSync(SCAN12_PDF));

      const session = await createOcrSession({ langs: 'eng' });
      const parts: Uint8Array[] = [];
      for (let n = 1; n <= 12; n += 1) {
        parts.push(await session.recognizeToPdfPage(asPageInput(await renderScanPage(scan, n, 150))));
      }
      await session.dispose();

      // Accumulator pattern of phase 5: fold every OCR_FOLD_EVERY (10) pages,
      // drop the raw parts, merge the folded chunks.
      const folded = await foldSearchablePdfParts(parts);
      expect(folded).toHaveLength(2);
      for (const part of parts) part.fill(0); // dropped by the caller post-fold

      const merged = await mergeSearchablePdfParts(folded);
      const doc = await PDFDocument.load(merged, { ignoreEncryption: false });
      expect(doc.getPageCount()).toBe(12);

      // Memory heuristic (R8): the output carries each page image exactly
      // once — merging must not duplicate the input payload.
      const inputBytes = parts.reduce((a, p) => a + p.length, 0);
      expect(inputBytes).toBeGreaterThan(merged.length);
      expect(merged.length).toBeLessThan(inputBytes * 1.1);

      // Fold order: page 1 lives in the first fold chunk, page 12 in the
      // second — both serials must land on their own pages.
      expect(norm(await getPageText(merged, 1))).toContain('8347001');
      expect(norm(await getPageText(merged, 12))).toContain('8347012');
    },
  );

  it('abort() finishes the in-flight page, then rejects the next with OcrAbortedError', { timeout: 120_000 }, async () => {
    const scan = new Uint8Array(readFileSync(VN_EN_PDF));
    const page1 = await renderScanPage(scan, 1, 200);

    const session = await createOcrSession({ langs: 'eng' });
    const inFlight = session.recognizeToPdfPage(asPageInput(page1));
    session.abort();
    const part = await inFlight;
    expect(part.length).toBeGreaterThan(0);
    expect(part[0]).toBe(0x25); // still a real PDF ("%PDF")

    await expect(session.recognizeToPdfPage(asPageInput(page1))).rejects.toBeInstanceOf(OcrAbortedError);
    await session.dispose();
  });

  it(
    'benchmark: ms/page with pdf output, eng vs vie on the 200dpi scan (phase 5 input)',
    { timeout: 120_000 },
    async () => {
      const scan = new Uint8Array(readFileSync(VN_EN_PDF));
      const enPage = await renderScanPage(scan, 1, 200);
      const vnPage = await renderScanPage(scan, 2, 200);

      const bench: Record<string, { initMs: number; enPageMs: number; viePageMs: number }> = {};
      for (const langs of ['eng', 'vie'] as const) {
        const t0 = performance.now();
        const session = await createOcrSession({ langs });
        const initMs = Math.round(performance.now() - t0);

        await session.recognizeToPdfPage(asPageInput(enPage)); // warm-up (first image, caches)

        const t1 = performance.now();
        const enPart = await session.recognizeToPdfPage(asPageInput(enPage));
        const enPageMs = Math.round(performance.now() - t1);

        const t2 = performance.now();
        const viePart = await session.recognizeToPdfPage(asPageInput(vnPage));
        const viePageMs = Math.round(performance.now() - t2);

        bench[langs] = { initMs, enPageMs, viePageMs };
        expect(enPart.length).toBeGreaterThan(0);
        expect(viePart.length).toBeGreaterThan(0);
        await session.dispose();
      }

      // eslint-disable-next-line no-console
      console.table(bench);
      for (const row of Object.values(bench)) {
        expect(row.enPageMs).toBeGreaterThan(0);
        expect(row.viePageMs).toBeGreaterThan(0);
      }
    },
  );
});
