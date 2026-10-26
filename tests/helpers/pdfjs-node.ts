/**
 * Vitest-only alias target for `pdfjs-dist` (wired in vite.config.ts
 * test.alias). The legacy build is the only one that runs under Node; this
 * module pre-sets an ABSOLUTE workerSrc on the shared legacy instance —
 * vitest 4's URL mangling otherwise sends pdf.js's fake-worker fallback to
 * the drive root ('D:\node_modules\...') and every getDocument dies.
 */
import * as legacy from 'pdfjs-dist/legacy/build/pdf.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

legacy.GlobalWorkerOptions.workerSrc = pathToFileURL(
  join(import.meta.dirname, '..', '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'),
).href;

export * from 'pdfjs-dist/legacy/build/pdf.mjs';
export default legacy;
