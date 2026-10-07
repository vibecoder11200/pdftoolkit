import { expose, transfer } from 'comlink';
import * as lib from '../engine/pdf-lib';
import { compressVectorPack, decryptPdf, encryptPdf, linearizePdf, qpdfCheck } from '../engine/qpdf';
import { zipStore } from '../lib/zip';

// pkijs/asn1js stay OUT of the worker's boot path: the cert module loads on
// first cert call, keeping loadPdf startup as fast as before phase 5.
import type { CertKeyInfo } from '../engine/p12';

/**
 * Raw RGBA pixel buffer (v0.4.0 phase 7), duck-typed instead of DOM ImageData
 * so callers can pass any {data, width, height} triple across comlink.
 */
export interface RasterImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface EncodeJpegOptions {
  /** mozjpeg quality, 1-100 (compress presets: balanced 75, small 60). */
  quality: number;
  /** Default true — progressive won every A/B cell (phase 7, D9). */
  progressive?: boolean;
}

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
  /**
   * Real-cert signing (v0.3.0 phase 5). The P12 is parsed HERE: the private
   * key never leaves the worker. The password crosses comlink by structured
   * clone — accepted (documented in docs/ENGINE-API.md), the UI wipes its
   * copy after use.
   */
  inspectCertificateKey(p12: Uint8Array, password: string): Promise<CertKeyInfo>;
  signWithCertificate(pdfBytes: Uint8Array, p12: Uint8Array, password: string): Promise<Uint8Array>;
  /**
   * mozjpeg encode (v0.4.0 phase 7, D9 gate: GO — A/B in
   * scripts/ab-mozjpeg.mjs measured 25.1% average size reduction vs the
   * skia/canvas.toBlob baseline across 2 fixtures x 3 quality levels;
   * progressive 25.1% / baseline 17.6%). The dynamic import keeps the wasm
   * codec chunk lazy; the emscripten glue resolves mozjpeg_enc.wasm relative
   * to its chunk URL under assets/ (same mechanism as qpdf.wasm).
   */
  encodeJpeg(imageData: RasterImageData, opts: EncodeJpegOptions): Promise<Uint8Array>;
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
  inspectCertificateKey: (p12, password) =>
    import('../engine/p12').then((m) => m.inspectCertificateKey(p12, password)),
  signWithCertificate: (pdfBytes, p12, password) =>
    import('../engine/p12').then((m) => m.signWithCertificate(pdfBytes, p12, password)),
  encodeJpeg: async (imageData, opts) => {
    // Lazy import: the @jsquash/jpeg + mozjpeg wasm chunks only load on the
    // first JPEG encode, never at worker boot.
    const { encode } = await import('@jsquash/jpeg');
    // Construct a real ImageData (jsquash only reads data/width/height).
    const input = new ImageData(imageData.data, imageData.width, imageData.height);
    const out = await encode(input, {
      quality: opts.quality,
      progressive: opts.progressive ?? true,
    });
    return transfer(new Uint8Array(out), [out]);
  },
};

expose(api);
