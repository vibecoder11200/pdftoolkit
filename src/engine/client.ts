import { wrap, transfer } from 'comlink';
import type { Remote } from 'comlink';
import type { WorkerApi } from '../workers/pdf.worker';
import { ownForWorker, shouldTransfer } from '../lib/buffers';

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
  encryptPdf: (bytes: Uint8Array, user: string, owner: string, bits?: 128 | 256) =>
    getWorker().encryptPdf(owned(bytes) as Uint8Array, user, owner, bits),
  decryptPdf: (bytes: Uint8Array, password: string) =>
    getWorker().decryptPdf(owned(bytes) as Uint8Array, password),
  qpdfCheck: (bytes: Uint8Array) => getWorker().qpdfCheck(owned(bytes) as Uint8Array),
};
