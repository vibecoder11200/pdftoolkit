/// <reference types="vite/client" />

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
