// Phase 4a (plan v0.4.0, D7/D8, red-team R8/R13/R14): OCR engine core —
// eng+vie, OEM.LSTM_ONLY, searchable-PDF page output, fold-merge, page cap.
//
// Design constraints baked into this module:
//
// - Anti-CDN (R14): EVERY asset URL is derived from `import.meta.env.BASE_URL`
//   (same-origin relative, ocrAssetUrl() refuses absolute URLs). tesseract.js
//   v7 defaults workerPath/corePath/langPath to the jsDelivr public CDN (see its
//   src/worker/browser/defaultOptions.js and worker-script getCore/loadLanguage)
//   — all three are overridden on createWorker, and `workerBlobURL: false` so
//   the worker spawns directly from the bundled `?url` import. Unit tests pin
//   every override so a CDN regression cannot land silently.
// - Lazy: nothing tesseract is imported statically (types only). Phase 5
//   dynamic-imports this module, so tesseract.js, its worker script and
//   pdf-lib never enter the entry bundle.
// - Lazy assets, NOT SW precache (decision overriding the phase file): the
//   measured OCR asset set (~11.7MB core + ~14.7MB tessdata) is far over the
//   plan's hard 17MB precache budget, so the assets are excluded from the
//   workbox precache. ensureOcrAssets() pins each one in a Cache API store
//   (`pdftoolkit-ocr-v1`) on first use: cache.match → on miss fetch()
//   (same-origin only) → cache.put. The web app is therefore offline-capable
//   AFTER the first OCR run; the desktop app serves the same URLs straight
//   from the on-disk bundle, where the store is a warm-up only. (The
//   tesseract worker additionally caches gunzipped traineddata in IndexedDB
//   after the first load, and the core .wasm.js is served through the normal
//   HTTP cache — the store is the explicit, inspectable pin for both.)
// - Memory (R8/D7): per-page PDF parts are folded — merged every
//   OCR_FOLD_EVERY pages and the merged inputs dropped (foldSearchablePdfParts)
//   — and the worker itself is terminated+recreated every OCR_RECYCLE_EVERY
//   recognized pages, so neither tesseract's wasm heap nor the parts array
//   grows with document length. Runs are capped at OCR_PAGE_CAP pages
//   (assertPageCountOk); phase 5 builds its confirm gate on top of that error.

import { PDFDocument } from 'pdf-lib';
import type { ImageLike, LoggerMessage, Worker as TesseractWorker } from 'tesseract.js';
import workerScriptUrl from 'tesseract.js/dist/worker.min.js?url';

/** Cache API store where OCR runtime assets are pinned on first use. */
export const OCR_CACHE_NAME = 'pdftoolkit-ocr-v1';

/** Fold-merge the accumulated per-page PDF parts every K pages (R8/D7). */
export const OCR_FOLD_EVERY = 10;

/** Hard per-run page cap (D7); phase 5 builds the UI confirm gate on top. */
export const OCR_PAGE_CAP = 100;

/** Terminate+recreate the tesseract worker after this many pages (R8). */
export const OCR_RECYCLE_EVERY = 25;

/**
 * Core runtime files, served from `${BASE_URL}tesseract-core/` (exported for
 * tests and the phase 5 preloader UI). These are the
 * emscripten single-file builds (wasm embedded) that tesseract.js 7.0.0's
 * getCore() importScripts: it probes relaxedSimd → simd → plain, so all three
 * lstm-only builds are preloaded (whichever matches is used, the other two
 * stay in the Cache API store for other devices on the same profile — each
 * file is only ~3.9MB). See scripts/sync-tessdata.mjs for the sync side.
 */
export const CORE_ASSETS = [
  'tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js',
  'tesseract-core/tesseract-core-simd-lstm.wasm.js',
  'tesseract-core/tesseract-core-lstm.wasm.js',
] as const;

export type OcrLangs = 'eng' | 'vie' | 'vie+eng' | 'eng+vie';

export interface OcrProgress {
  /** tesseract status string (e.g. "recognizing text"). */
  status: string;
  /** 0..1 within the current status. */
  progress: number;
}

export interface OcrTextResult {
  text: string;
  /** Mean per-word confidence for the page (tesseract MeanTextConf, 0..100). */
  confidence: number;
}

/** One page image to recognize. ImageData is wrapped into an OffscreenCanvas. */
export type OcrPageInput = HTMLCanvasElement | OffscreenCanvas | ImageData | Blob;

export class OcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrError';
  }
}

/** An OCR runtime asset could not be fetched/pinned (offline first use, 404). */
export class OcrAssetError extends OcrError {
  readonly url: string;

  constructor(url: string, message: string, cause?: unknown) {
    super(`${message} (${url})`);
    this.name = 'OcrAssetError';
    this.url = url;
    if (cause !== undefined) this.cause = cause;
  }
}

/** abort() was called before this recognize call started (page-boundary abort). */
export class OcrAbortedError extends OcrError {
  constructor() {
    super('OCR run aborted');
    this.name = 'OcrAbortedError';
  }
}

/** Document exceeds OCR_PAGE_CAP pages (D7). */
export class OcrPageCapError extends OcrError {
  readonly pageCount: number;

  constructor(pageCount: number) {
    super(`PDF has ${pageCount} pages — OCR is capped at ${OCR_PAGE_CAP} pages per run`);
    this.name = 'OcrPageCapError';
    this.pageCount = pageCount;
  }
}

/**
 * Same-origin asset URL under BASE_URL. Refuses anything not starting with "/"
 * so a bad BASE_URL can never turn into an absolute/CDN fetch (R14).
 */
export function ocrAssetUrl(relativePath: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  const url = `${base}/${relativePath.replace(/^\/+/, '')}`;
  if (!url.startsWith('/')) throw new OcrAssetError(url, 'OCR asset URL must be same-origin');
  return url;
}

function parseLangs(langs: OcrLangs): string[] {
  const langs_ = langs.split('+').map((lang) => lang.trim());
  if (langs_.length === 0) throw new OcrError(`no OCR languages given: "${langs}"`);
  for (const lang of langs_) {
    // tesseract lang codes: "eng", "vie", "chi_sim", ... — path-segment safe.
    if (!/^[a-z]{2,3}(_[A-Za-z0-9]{1,8})?$/i.test(lang)) {
      throw new OcrError(`invalid OCR language code: "${lang}"`);
    }
  }
  return langs_;
}

/**
 * Pin every asset the given language set needs in the OCR Cache API store:
 * the 3 core single-file builds plus `<lang>.traineddata.gz` per language.
 * Cache hits never hit the network; misses are fetched sequentially with a
 * same-origin relative URL (no code path can reach a CDN — R14) and stored
 * for offline reuse. Any failure throws OcrAssetError.
 */
export async function ensureOcrAssets(langs: OcrLangs): Promise<void> {
  const files: string[] = [
    ...CORE_ASSETS,
    ...parseLangs(langs).map((lang) => `tessdata/${lang}.traineddata.gz`),
  ];
  const storage = globalThis.caches;
  if (!storage) {
    throw new OcrAssetError(ocrAssetUrl(files[0]!), 'Cache API unavailable — OCR assets cannot be pinned');
  }
  const cache = await storage.open(OCR_CACHE_NAME);
  for (const file of files) {
    const url = ocrAssetUrl(file);
    const hit = await cache.match(url);
    if (hit) continue;
    let response: Response;
    try {
      response = await fetch(url);
    } catch (cause) {
      throw new OcrAssetError(url, 'fetch failed', cause);
    }
    if (!response.ok) throw new OcrAssetError(url, `HTTP ${response.status} ${response.statusText}`);
    await cache.put(url, response);
  }
}

/**
 * Guard for the D7 page cap. Phase 5 checks this before starting a run and
 * shows its confirm/back-out UI on OcrPageCapError.
 */
export function assertPageCountOk(pageCount: number): void {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new OcrError(`invalid page count: ${pageCount}`);
  if (pageCount > OCR_PAGE_CAP) throw new OcrPageCapError(pageCount);
}

export interface OcrSessionOptions {
  langs: OcrLangs;
  onProgress?: (progress: OcrProgress) => void;
}

export interface OcrSession {
  readonly langs: OcrLangs;
  // Recognize calls are sequential by contract (phase 5 processes one page at
  // a time, abort/recycle happen at page boundaries).
  /** Text + mean per-word confidence for one page (auto-language mode). */
  recognizeText(page: OcrPageInput): Promise<OcrTextResult>;
  /** Searchable single-page PDF bytes (tesseract pdf output). */
  recognizeToPdfPage(page: OcrPageInput): Promise<Uint8Array>;
  /** Phase 5: text + confidence + searchable PDF page in ONE recognition pass. */
  recognizePage(page: OcrPageInput): Promise<OcrTextResult & { pdf: Uint8Array }>;
  /** Abort at the page boundary: the in-flight page finishes, the next call rejects. */
  abort(): void;
  /** Terminate the underlying worker; the session is unusable afterwards. */
  dispose(): Promise<void>;
}

/**
 * Create an OCR session. Lazily imports tesseract.js (never in the entry
 * bundle), pins the runtime assets (ensureOcrAssets), then spawns a worker
 * with every CDN-able path overridden to bundled same-origin assets.
 */
export async function createOcrSession(options: OcrSessionOptions): Promise<OcrSession> {
  await ensureOcrAssets(options.langs);
  const { createWorker, OEM } = await import('tesseract.js');

  const spawnWorker = (): Promise<TesseractWorker> =>
    createWorker(options.langs, OEM.LSTM_ONLY, {
      // ?url import of the bundled dist/worker.min.js (default: jsdelivr CDN).
      workerPath: workerScriptUrl,
      // Directory anchor — v7 getCore picks the matching single-file build.
      corePath: ocrAssetUrl('tesseract-core'),
      // No trailing slash (v7 appends `/${lang}.traineddata.gz`; gzip: true).
      langPath: ocrAssetUrl('tessdata'),
      gzip: true,
      // v7 spawnWorker otherwise wraps workerPath in a Blob importScripts.
      workerBlobURL: false,
      ...(options.onProgress
        ? {
            logger: (message: LoggerMessage) =>
              options.onProgress?.({ status: message.status, progress: message.progress }),
          }
        : {}),
      // v7's onMessage throws the raw rejection inside its own message
      // handler when no errorHandler is set (double-reporting job failures
      // that we already handle via the rejected recognize promise).
      errorHandler: () => {},
    });

  let worker = await spawnWorker();
  let aborted = false;
  let disposed = false;
  let pagesDone = 0;

  async function recognize(page: OcrPageInput, output: { text?: true; pdf?: true }) {
    if (disposed) throw new OcrError('OCR session disposed');
    if (aborted) throw new OcrAbortedError();
    const image = await toImageLike(page);
    const result = await worker.recognize(image, {}, output);
    pagesDone += 1;
    if (pagesDone % OCR_RECYCLE_EVERY === 0) {
      // R8: bound the wasm heap. Terminate first so at most one full core is
      // alive between pages; a failed respawn surfaces at this boundary.
      await worker.terminate();
      worker = await spawnWorker();
    }
    return result.data;
  }

  return {
    langs: options.langs,
    async recognizeText(page) {
      const data = await recognize(page, { text: true });
      return { text: data.text, confidence: data.confidence };
    },
    async recognizeToPdfPage(page) {
      const data = await recognize(page, { pdf: true });
      // v7 typings declare `pdf: number[] | null`; across the worker boundary
      // the value is the emscripten FS readFile result (a Uint8Array).
      if (!data.pdf || data.pdf.length === 0) throw new OcrError('tesseract returned no PDF output for the page');
      return data.pdf instanceof Uint8Array ? data.pdf : Uint8Array.from(data.pdf);
    },
    // Phase 5: text + searchable PDF from ONE recognition pass (calling
    // recognizeText+recognizeToPdfPage would run tesseract twice per page).
    async recognizePage(page) {
      const data = await recognize(page, { text: true, pdf: true });
      if (!data.pdf || data.pdf.length === 0) throw new OcrError('tesseract returned no PDF output for the page');
      return {
        text: data.text,
        confidence: data.confidence,
        pdf: data.pdf instanceof Uint8Array ? data.pdf : Uint8Array.from(data.pdf),
      };
    },
    abort() {
      aborted = true;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      aborted = true;
      await worker.terminate();
    },
  };
}

function isImageData(page: OcrPageInput): page is ImageData {
  // Guarded typeof: ImageData is not a global in node-side tests.
  return typeof ImageData !== 'undefined' && page instanceof ImageData;
}

async function toImageLike(page: OcrPageInput): Promise<ImageLike> {
  // tesseract v7 accepts canvases/blobs directly; ImageData needs a wrap.
  if (isImageData(page)) {
    const canvas = new OffscreenCanvas(page.width, page.height);
    canvas.getContext('2d')?.putImageData(page, 0, 0);
    return canvas;
  }
  return page;
}

/**
 * Merge searchable-PDF page parts (as produced by recognizeToPdfPage) into a
 * single PDF. Pure: inputs are read, never mutated.
 *
 * `useObjectStreams: false` matches src/engine/pdf-lib.ts: the fold
 * accumulator below is re-parsed and re-serialized on every fold, and plain
 * xref output avoids recompressing the whole document at each fold while
 * keeping maximum viewer compatibility for generated files.
 */
export async function mergeSearchablePdfParts(parts: Uint8Array[]): Promise<Uint8Array> {
  if (parts.length === 0) throw new OcrError('mergeSearchablePdfParts: no parts given');
  const out = await PDFDocument.create();
  for (const part of parts) {
    const src = await PDFDocument.load(part, { ignoreEncryption: false });
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
  }
  return out.save({ useObjectStreams: false });
}

/**
 * Fold-merge (R8/D7): merge every `every`-sized chunk of parts into one PDF
 * and return the new (shorter) part list, preserving order. Pure — callers
 * drop the previous array and keep accumulating: with K=10 and 100 pages the
 * live set never exceeds 10 page parts + one 10-page PDF.
 */
export async function foldSearchablePdfParts(
  parts: Uint8Array[],
  every: number = OCR_FOLD_EVERY,
): Promise<Uint8Array[]> {
  if (!Number.isInteger(every) || every < 1) throw new OcrError(`fold size must be a positive integer: ${every}`);
  const folded: Uint8Array[] = [];
  for (let i = 0; i < parts.length; i += every) {
    folded.push(await mergeSearchablePdfParts(parts.slice(i, i + every)));
  }
  return folded;
}
