// Main-thread pdf.js preview/thumbnail adapter.
// Spike S2: browser/Vite uses the modern build; the worker file is bundled
// via `?url` + `new URL(...)`. The legacy build is test-only (Node).
// No text-layer UI ships; getTextContent is used in test helpers only.
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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
