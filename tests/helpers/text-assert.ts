// Test-only helper: asserts a PDF still carries selectable text.
// Never ships a text-layer UI; production stays canvas-only.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const legacy = require('pdfjs-dist/legacy/build/pdf.mjs') as typeof import('pdfjs-dist');

export async function getTextOfFirstPage(bytes: Uint8Array): Promise<string> {
  const loadingTask = legacy.getDocument({ data: bytes.slice() });
  const doc = await loadingTask.promise;
  try {
    const page = await doc.getPage(1);
    const tc = await page.getTextContent();
    return tc.items.map((i) => ('str' in i ? String(i.str) : '')).join(' ');
  } finally {
    await loadingTask.destroy();
  }
}

export async function pageCountOf(bytes: Uint8Array): Promise<number> {
  const loadingTask = legacy.getDocument({ data: bytes.slice() });
  const doc = await loadingTask.promise;
  try {
    return doc.numPages;
  } finally {
    await loadingTask.destroy();
  }
}
