import { wrap, transfer } from 'comlink';
import type { Remote } from 'comlink';
import type { WorkerApi } from '../workers/pdf.worker';
import { ownForWorker, shouldTransfer } from '../lib/buffers';
import { robotoBytes } from '../lib/roboto';

let remote: Remote<WorkerApi> | null = null;

export function getWorker(): Remote<WorkerApi> {
  if (!remote) {
    const worker = new Worker(new URL('../workers/pdf.worker.ts', import.meta.url), {
      type: 'module',
    });
    remote = wrap<WorkerApi>(worker);
  }
  return remote;
}

function owned(bytes: Uint8Array): Uint8Array | Transferable {
  const mode = shouldTransfer(bytes.byteLength) ? 'transfer' : 'copy';
  const ownedBuf = ownForWorker(bytes, { mode, byteLength: bytes.byteLength });
  return mode === 'transfer' ? transfer(ownedBuf.bytes, ownedBuf.transfer) : ownedBuf.bytes;
}

export const engine = {
  loadPdf: (bytes: Uint8Array) => getWorker().loadPdf(owned(bytes) as Uint8Array),
  mergePdfs: (parts: Uint8Array[]) =>
    getWorker().mergePdfs(parts.map((p) => owned(p) as Uint8Array)),
  mergeSelected: (parts: Uint8Array[], picks: number[][]) =>
    getWorker().mergeSelected(
      parts.map((p) => owned(p) as Uint8Array),
      picks,
    ),
  removePages: (bytes: Uint8Array, pages: number[]) =>
    getWorker().removePages(owned(bytes) as Uint8Array, pages),
  reorderPages: (bytes: Uint8Array, order: number[]) =>
    getWorker().reorderPages(owned(bytes) as Uint8Array, order),
  rotatePages: (bytes: Uint8Array, targets: number[], degrees: 90 | 180 | 270) =>
    getWorker().rotatePages(owned(bytes) as Uint8Array, targets, degrees),
  splitRanges: (bytes: Uint8Array, ranges: number[][]) =>
    getWorker().splitRanges(owned(bytes) as Uint8Array, ranges),
  extractPages: (bytes: Uint8Array, targets: number[]) =>
    getWorker().extractPages(owned(bytes) as Uint8Array, targets),
  compressVectorPack: (bytes: Uint8Array) =>
    getWorker().compressVectorPack(owned(bytes) as Uint8Array),
  linearizePdf: (bytes: Uint8Array) => getWorker().linearizePdf(owned(bytes) as Uint8Array),
  encryptPdf: (bytes: Uint8Array, user: string, owner: string, bits?: 128 | 256) =>
    getWorker().encryptPdf(owned(bytes) as Uint8Array, user, owner, bits),
  decryptPdf: (bytes: Uint8Array, password: string) =>
    getWorker().decryptPdf(owned(bytes) as Uint8Array, password),
  qpdfCheck: (bytes: Uint8Array) => getWorker().qpdfCheck(owned(bytes) as Uint8Array),
  zipStore: (entries: { name: string; bytes: Uint8Array }[]) =>
    getWorker().zipStore(entries.map((e) => ({ name: e.name, bytes: owned(e.bytes) as Uint8Array }))),
  markdownToDocx: (pages: import('../lib/markdown-docx').DocxPages) => getWorker().markdownToDocx(pages),
  inspectCertificateKey: (p12: Uint8Array, password: string) =>
    getWorker().inspectCertificateKey(owned(p12) as Uint8Array, password),
  signWithCertificate: (pdfBytes: Uint8Array, p12: Uint8Array, password: string) =>
    getWorker().signWithCertificate(
      owned(pdfBytes) as Uint8Array,
      owned(p12) as Uint8Array,
      password,
    ),
  // Watermark/page-numbers (v0.8.0): the font (and image bytes, when present)
  // are CALLER-OWNED — sliced per call before the send (every send copies
  // across comlink anyway; buffers.ts). fontTtf omitted → the shared Roboto.
  stampWatermark: async (
    bytes: Uint8Array,
    opts: import('../engine/pdf-lib').StampWatermarkOptions,
    fontTtf?: Uint8Array,
  ) => {
    const font = (fontTtf ?? (await robotoBytes())).slice();
    return getWorker().stampWatermark(owned(bytes) as Uint8Array, opts, owned(font) as Uint8Array);
  },
  applyPageNumbers: async (
    bytes: Uint8Array,
    opts: import('../engine/pdf-lib').PageNumbersOptions,
    fontTtf?: Uint8Array,
  ) => {
    const font = (fontTtf ?? (await robotoBytes())).slice();
    return getWorker().applyPageNumbers(owned(bytes) as Uint8Array, opts, owned(font) as Uint8Array);
  },
};
