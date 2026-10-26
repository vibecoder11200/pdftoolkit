// Main-thread pdf.js preview/thumbnail adapter.
// Spike S2: browser/Vite uses the modern build; the worker file is bundled
// via `?url` + `new URL(...)`. The legacy build is test-only (Node).
// No text-layer UI ships; getTextContent is used in test helpers only.
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

// vitest aliases pdfjs-dist to a helper that pre-sets an absolute workerSrc
// (the Node-safe legacy worker); never overwrite a preset value.
if (!pdfjs.GlobalWorkerOptions.workerSrc) {
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

// Standard-font programs (Helvetica & friends) for PDFs that reference them
// without embedding. Emitted next to the JS bundle by vite.config.ts and
// precached by the service worker, so offline rendering keeps its glyphs.
const standardFontDataUrl = `${import.meta.env.BASE_URL}assets/standard_fonts/`;

// One pdf.js document per source buffer: getDocument transfers `data` into
// the worker, so each load takes its own slice. Re-loading the document for
// every page render (the old behavior) double-loads the file per thumbnail
// and blows the <2x RAM budget from phase 2. Small LRU bounds worker-side
// memory across a long multi-file session; rejected loads (corrupt file)
// are dropped so a retry gets a fresh attempt.
const MAX_CACHED_DOCS = 3;
const docCache = new Map<
  Uint8Array,
  { task: pdfjs.PDFDocumentLoadingTask; doc: Promise<pdfjs.PDFDocumentProxy> }
>();

function getDoc(bytes: Uint8Array): Promise<pdfjs.PDFDocumentProxy> {
  const cached = docCache.get(bytes);
  if (cached) {
    // Refresh LRU order.
    docCache.delete(bytes);
    docCache.set(bytes, cached);
    return cached.doc;
  }
  const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl });
  const doc = task.promise;
  docCache.set(bytes, { task, doc });
  void doc.catch(() => {
    if (docCache.get(bytes)?.doc === doc) docCache.delete(bytes);
  });
  while (docCache.size > MAX_CACHED_DOCS) {
    const oldestKey = docCache.keys().next().value as Uint8Array;
    const oldest = docCache.get(oldestKey);
    docCache.delete(oldestKey);
    void oldest?.task.destroy();
  }
  return doc;
}

export async function renderPageToCanvas(
  data: Uint8Array,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale = 1.5,
): Promise<{ width: number; height: number }> {
  const doc = await getDoc(data);
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('pdfjs: 2d context unavailable');
  await page.render({ canvas, viewport }).promise;
  return { width: canvas.width, height: canvas.height };
}

// Phase 5 (R21): page count for the OCR cap gate, and first-page text for
// the "this PDF already has a text layer" warning.
export async function getPageCount(data: Uint8Array): Promise<number> {
  const doc = await getDoc(data);
  return doc.numPages;
}

export async function getFirstPageText(data: Uint8Array): Promise<string> {
  const doc = await getDoc(data);
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  return content.items
    .map((item) => ('str' in item ? item.str : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A rectangle in VISUAL space: origin bottom-left of the visible page box
 * (rotation + CropBox baked), x right, y up — the same space the redact
 * engine's RedactRect and the user's drag marks live in. */
export interface VisualRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Visible page box at scale 1 — pdf.js bakes /Rotate + CropBox into the
 * viewport, so width/height ARE the visual-space dimensions (spike-proven
 * consistent with the engine's visibleGeometry). */
export async function getPageVisualSize(
  data: Uint8Array,
  pageNumber: number,
): Promise<{ width: number; height: number }> {
  const doc = await getDoc(data);
  const page = await doc.getPage(pageNumber);
  const vp = page.getViewport({ scale: 1 });
  return { width: vp.width, height: vp.height };
}

/** Raw positional text items of a page (pdf.js getTextContent, unfiltered —
 * callers decide). One extraction path for every consumer: highlight
 * quads (annotate M2), run selection (editor M3), text-search marking. */
export interface PdfTextItem {
  str: string;
  /** pdf.js text-space transform [a b c d e f]. */
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}

export async function getPageTextItems(
  data: Uint8Array,
  pageNumber: number,
): Promise<PdfTextItem[]> {
  const doc = await getDoc(data);
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  const out: PdfTextItem[] = [];
  for (const item of content.items) {
    if (!('str' in item)) continue;
    out.push({
      str: item.str,
      transform: [...item.transform],
      width: item.width,
      height: item.height,
      fontName: item.fontName,
    });
  }
  return out;
}

/** Every text item's bounding box on a page, in VISUAL space (redact
 * semantic-verify leg). Zero-width items (EOL markers) are skipped. */
export async function getTextItemRects(
  data: Uint8Array,
  pageNumber: number,
): Promise<VisualRect[]> {
  const doc = await getDoc(data);
  const page = await doc.getPage(pageNumber);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const out: VisualRect[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim() || item.width === 0) continue;
    // Map the text-matrix through the viewport (bakes /Rotate + CropBox),
    // then take the pdf.js text-layer box: hypot(td[2], td[3]) is the
    // device-space glyph height, item.width the advance width.
    const td = pdfjs.Util.transform(vp.transform, item.transform);
    const fontHeight = Math.hypot(td[2], td[3]);
    if (fontHeight === 0) continue;
    const left = td[4];
    const top = td[5] - fontHeight; // viewport space: origin top-left, y down
    out.push({ x: left, y: vp.height - top - fontHeight, w: item.width, h: fontHeight });
  }
  return out;
}
