/// <reference types="vite/client" />

// Build-time identity injected by vite.config.ts `define` (footer chip).
declare const __APP_VERSION__: string;
declare const __COMMIT_HASH__: string;

// Plain registration module (the /react hook variant cannot skip
// registration — see use-app-update.tsx). Shape mirrors
// vite-plugin-pwa/client.d.ts.
declare module 'virtual:pwa-register' {
  export function registerSW(options?: {
    immediate?: boolean;
    onNeedReload?: () => void;
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
    onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
    onRegisteredSW?: (
      swScriptUrl: string,
      registration: ServiceWorkerRegistration | undefined,
    ) => void;
    onRegisterError?: (error: unknown) => void;
  }): Promise<(reloadPage?: boolean) => Promise<void>>;
}

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
