// Main-thread pdf.js preview/thumbnail adapter.
// Spike S2: browser/Vite uses the modern build; the worker file is bundled
// via `?url` + `new URL(...)`. The legacy build is test-only (Node).
// No text-layer UI ships; getTextContent is used in test helpers only.
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export async function renderPageToCanvas(
  data: Uint8Array,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale = 1.5,
): Promise<{ width: number; height: number }> {
  const bytes = data.slice();
  const loadingTask = pdfjs.getDocument({ data: bytes });
  const doc = await loadingTask.promise;
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('pdfjs: 2d context unavailable');
    await page.render({ canvas, viewport }).promise;
    return { width: canvas.width, height: canvas.height };
  } finally {
    await loadingTask.destroy();
  }
}
