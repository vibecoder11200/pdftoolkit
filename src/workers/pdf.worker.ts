import { expose } from 'comlink';
import * as lib from '../engine/pdf-lib';
import { compressVectorPack, decryptPdf, encryptPdf, linearizePdf, qpdfCheck } from '../engine/qpdf';
import { zipStore } from '../lib/zip';

export interface WorkerApi {
  loadPdf(bytes: Uint8Array): Promise<{ info: import('../engine/pdf-lib').PdfInfo }>;
  mergePdfs(parts: Uint8Array[]): Promise<Uint8Array>;
  mergeSelected(parts: Uint8Array[], picks: number[][]): Promise<Uint8Array>;
  removePages(bytes: Uint8Array, pages: number[]): Promise<Uint8Array>;
  reorderPages(bytes: Uint8Array, order: number[]): Promise<Uint8Array>;
  rotatePages(bytes: Uint8Array, targets: number[], degrees: 90 | 180 | 270): Promise<Uint8Array>;
  splitRanges(bytes: Uint8Array, ranges: number[][]): Promise<Uint8Array[]>;
  extractPages(bytes: Uint8Array, targets: number[]): Promise<Uint8Array>;
  compressVectorPack(bytes: Uint8Array): Promise<Uint8Array>;
  linearizePdf(bytes: Uint8Array): Promise<Uint8Array>;
  encryptPdf(bytes: Uint8Array, user: string, owner: string, bits?: 128 | 256): Promise<Uint8Array>;
  decryptPdf(bytes: Uint8Array, password: string): Promise<Uint8Array>;
  qpdfCheck(bytes: Uint8Array): Promise<void>;
  zipStore(entries: { name: string; bytes: Uint8Array }[]): Promise<Uint8Array>;
}

const api: WorkerApi = {
  loadPdf: (bytes) => lib.loadPdf(bytes),
  mergePdfs: (parts) => lib.mergePdfs(parts),
  mergeSelected: (parts, picks) => lib.mergeSelected(parts, picks),
  removePages: (bytes, pages) => lib.removePages(bytes, pages),
  reorderPages: (bytes, order) => lib.reorderPages(bytes, order),
  rotatePages: (bytes, targets, degrees) => lib.rotatePages(bytes, targets, degrees),
  splitRanges: (bytes, ranges) => lib.splitByRanges(bytes, ranges),
  extractPages: (bytes, targets) => lib.extractPages(bytes, targets),
  compressVectorPack: (bytes) => compressVectorPack(bytes),
  linearizePdf: (bytes) => linearizePdf(bytes),
  encryptPdf: (bytes, user, owner, bits) => encryptPdf(bytes, user, owner, bits),
  decryptPdf: (bytes, password) => decryptPdf(bytes, password),
  qpdfCheck: (bytes) => qpdfCheck(bytes),
  zipStore: async (entries) => zipStore(entries),
};

expose(api);
