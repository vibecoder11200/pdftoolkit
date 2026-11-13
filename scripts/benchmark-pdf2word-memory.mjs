import fs from 'node:fs';
import crypto from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run one fixture per Node process with --experimental-transform-types
// --expose-gc. Measures extraction/composer, not browser heap or DOCX packing.
const sourcePath = resolve(process.argv[3] ?? 'src/lib/pdf2word.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const { runPdf2Word } = await import(pathToFileURL(sourcePath).href);
const fixture = process.argv[2];
if (!fixture) throw new Error('Pass a synthetic PDF path and optional composer source path');
const bytes = new Uint8Array(fs.readFileSync(fixture));
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(resolve('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
const loadingTask = pdfjs.getDocument({
  data: bytes.slice(),
  standardFontDataUrl: pathToFileURL(resolve('node_modules/pdfjs-dist/standard_fonts')).href + '/',
  useSystemFonts: true,
});
const doc = await loadingTask.promise;
let peak = process.memoryUsage();
const sample = () => {
  const memory = process.memoryUsage();
  for (const key of Object.keys(memory)) peak[key] = Math.max(peak[key], memory[key]);
};
global.gc?.();
const start = process.memoryUsage();
const timer = setInterval(sample, 5);
const started = performance.now();
try {
  const result = await runPdf2Word({
    pageCount: doc.numPages,
    extractPage: async (pageNumber) => {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const text = await page.getTextContent();
      const items = [];
      for (const item of text.items) {
        if (!('str' in item) || !item.str.trim() || item.width === 0) continue;
        const transform = pdfjs.Util.transform(viewport.transform, item.transform);
        const size = Math.hypot(transform[2], transform[3]);
        if (size === 0) continue;
        items.push({
          str: item.str.normalize('NFKC'), x0: transform[4], x1: transform[4] + item.width,
          baseline: transform[5], size, fontName: item.fontName,
          rotated: Math.abs(transform[1]) > 0.1 * Math.hypot(transform[0], transform[1]),
        });
      }
      items.sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
      sample();
      return items;
    },
    toDocx: async ({ texts }) => new TextEncoder().encode(texts.join('\n\f\n')),
    aiConvertPages: async pages => pages.map(page => `Synthetic scan page ${page}`),
    onProgress: sample,
  });
  sample();
  console.log(JSON.stringify({
    fixture, fixtureSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    runtime: process.version, platform: process.platform, gc: !!global.gc,
    pages: result.markdown.length, mode: result.mode,
    markdownSha256: crypto.createHash('sha256').update(JSON.stringify(result.markdown)).digest('hex'),
    start, peak, end: process.memoryUsage(), elapsedMs: performance.now() - started,
    scope: 'Node RSS/heap; real legacy pdf.js extraction; markdown emitter stub, not DOCX packing or browser heap; document retained until run ends',
  }, null, 2));
} finally {
  clearInterval(timer);
  await loadingTask.destroy();
}
