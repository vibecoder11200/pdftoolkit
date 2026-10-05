import { PDFDocument } from 'pdf-lib';

export interface PageInfo {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
}

export interface PdfInfo {
  numPages: number;
  pageInfos: PageInfo[];
  fingerprint: string;
  fileSizeBytes: number;
}

function fingerprint(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const n = Math.min(bytes.length, 65536);
  for (let i = 0; i < n; i += 1) {
    h1 = Math.imul(h1 ^ bytes[i], 16777619);
    h2 = Math.imul(h2 + bytes[i], 31);
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}

export async function loadPdf(bytes: Uint8Array): Promise<{ info: PdfInfo }> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const pageInfos: PageInfo[] = doc.getPages().map((page, i) => ({
    pageNumber: i + 1,
    width: page.getWidth(),
    height: page.getHeight(),
    rotation: page.getRotation().angle,
  }));
  return {
    info: {
      numPages: doc.getPageCount(),
      pageInfos,
      fingerprint: fingerprint(bytes),
      fileSizeBytes: bytes.byteLength,
    },
  };
}

export async function mergePdfs(parts: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const part of parts) {
    const src = await PDFDocument.load(part, { ignoreEncryption: false });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  return out.save({ useObjectStreams: false });
}

export async function mergeSelected(parts: Uint8Array[], picks: number[][]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (let i = 0; i < parts.length; i += 1) {
    const sel = picks[i] ?? [];
    if (sel.length === 0) continue;
    const src = await PDFDocument.load(parts[i], { ignoreEncryption: false });
    const pages = await out.copyPages(src, sel.map((n) => n - 1));
    for (const p of pages) out.addPage(p);
  }
  return out.save({ useObjectStreams: false });
}

export async function removePages(bytes: Uint8Array, pagesToRemove: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const indices = [...new Set(pagesToRemove.map((n) => n - 1))]
    .filter((i) => i >= 0 && i < doc.getPageCount())
    .sort((a, b) => b - a);
  for (const i of indices) doc.removePage(i);
  return doc.save({ useObjectStreams: false });
}

export async function reorderPages(bytes: Uint8Array, order: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const count = src.getPageCount();
  if (order.length !== count) throw new Error(`reorder: order length ${order.length} != ${count}`);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, order.map((n) => n - 1));
  for (const p of pages) out.addPage(p);
  return out.save({ useObjectStreams: false });
}

export async function rotatePages(
  bytes: Uint8Array,
  targets: number[],
  degrees: 90 | 180 | 270,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  for (const n of targets) {
    const page = doc.getPage(n - 1);
    const cur = page.getRotation().angle;
    page.setRotation({ type: 'degrees', angle: (cur + degrees) % 360 } as never);
  }
  return doc.save({ useObjectStreams: false });
}

export async function splitByRanges(
  bytes: Uint8Array,
  ranges: number[][],
): Promise<Uint8Array[]> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const out: Uint8Array[] = [];
  for (const range of ranges) {
    const doc = await PDFDocument.create();
    const pages = await doc.copyPages(src, range.map((n) => n - 1));
    for (const p of pages) doc.addPage(p);
    out.push(await doc.save({ useObjectStreams: false }));
  }
  return out;
}

export async function extractPages(bytes: Uint8Array, targets: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const doc = await PDFDocument.create();
  const pages = await doc.copyPages(src, targets.map((n) => n - 1));
  for (const p of pages) doc.addPage(p);
  return doc.save({ useObjectStreams: false });
}
