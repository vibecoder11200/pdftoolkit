/// <reference types="vite/client" />

// Build-time identity injected by vite.config.ts `define` (footer chip).
declare const __APP_VERSION__: string;
declare const __COMMIT_HASH__: string;

declare module 'js-pdf-signer' {
  export interface Signer {
    cert: unknown;
    privateKey: CryptoKey;
  }
  export function addSignaturePlaceholder(opts: {
    pdfLib: typeof import('pdf-lib');
    pdfDocLib: import('pdf-lib').PDFDocument;
    field: { acroField: { dict: import('pdf-lib').PDFDict } };
    placeholderHexLen?: number;
  }): unknown;
  export function signPdfBytes(pdfBytes: Uint8Array, signer?: Signer): Promise<Uint8Array>;
  export function getOrCreateSigner(): Promise<Signer>;
}
