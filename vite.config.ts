import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Emit qpdf.wasm next to the worker chunk: the emscripten glue resolves it
// relative to the worker script dir (/assets/), and the lazy dynamic import
// keeps it out of the initial bundle. Node (vitest) reads it from node_modules.
const qpdfWasm = readFileSync(
  fileURLToPath(new URL('./node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm', import.meta.url)),
);

// sha256 of node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm, refreshed
// here whenever the pinned package version in package.json changes. The
// precache entry for assets/qpdf.wasm gets content-hash URLs for JS (revision
// null = hash-in-filename) but the wasm keeps a stable filename, so pin its
// revision explicitly: a corrupt or swapped wasm can never silently serve
// from an old precache entry.
const qpdfWasmRevision = createHash('sha256').update(qpdfWasm).digest('hex');

// pdf.js standard-font programs, served from assets/standard_fonts/ (see
// src/engine/pdfjs.ts). Without them, PDFs that reference standard fonts
// without embedding render with missing glyphs in thumbnails/preview.
const standardFontsDir = fileURLToPath(
  new URL('./node_modules/pdfjs-dist/standard_fonts/', import.meta.url),
);
const standardFonts = readdirSync(standardFontsDir).filter((f) => /\.(pfb|ttf)$/.test(f));
const fontRevisions = Object.fromEntries(
  standardFonts.map((f) => [
    f,
    createHash('sha256').update(readFileSync(standardFontsDir + f)).digest('hex'),
  ]),
);

export default defineConfig({
  base: '/pdftoolkit/',
  resolve: {
    alias: {
      // js-pdf-signer's `browser` field is an IIFE with no exports; force the
      // CJS entry so named imports survive Vite's browser resolution.
      'js-pdf-signer': fileURLToPath(
        new URL('./node_modules/js-pdf-signer/src/index.js', import.meta.url),
      ),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'emit-qpdf-wasm',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'assets/qpdf.wasm', source: qpdfWasm });
        for (const f of standardFonts) {
          this.emitFile({
            type: 'asset',
            fileName: `assets/standard_fonts/${f}`,
            source: readFileSync(standardFontsDir + f),
          });
        }
      },
    },
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'generateSW',
      workbox: {
        // Fonts are build-emitted (not in public/), so they must be globbed
        // here — includeAssets only sees publicDir. Favicon set, PWA icons
        // and the webmanifest are precached too: an offline cold start (SW
        // navigateFallback) still needs theme-boot.js (**/*.js covers it),
        // the tab icon and the install manifest (red-team #16).
        globPatterns: [
          '**/*.{js,css,html}',
          'assets/qpdf.wasm',
          'assets/standard_fonts/*',
          'favicon.svg',
          'favicon-32.png',
          'apple-touch-icon-180.png',
          'icons/*.png',
          'manifest.webmanifest',
        ],
        maximumFileSizeToCacheInBytes: 30 * 1024 ** 2,
        navigateFallbackDenylist: [/^\/api/],
        // Pin the content hash of stable-filename assets (qpdf.wasm, fonts)
        // so a swapped binary can never silently serve from an old precache
        // entry (see qpdfWasmRevision / fontRevisions).
        manifestTransforms: [
          (entries) => ({
            manifest: entries.map((entry) => {
              if (entry.url === 'assets/qpdf.wasm') {
                return { ...entry, revision: qpdfWasmRevision };
              }
              const font = entry.url.match(/^assets\/standard_fonts\/(.+)$/)?.[1];
              if (font && fontRevisions[font]) {
                return { ...entry, revision: fontRevisions[font] };
              }
              return entry;
            }),
            warnings: undefined,
          }),
        ],
      },
      manifest: {
        name: 'PDF Toolkit',
        short_name: 'PDF Toolkit',
        description:
          'Merge, split, compress, convert and sign PDFs. 100% on-device, offline-capable, MIT open source.',
        scope: '/pdftoolkit/',
        start_url: '/pdftoolkit/',
        display: 'standalone',
        background_color: '#f8f8fc',
        theme_color: '#4f46e5',
        lang: 'vi',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  worker: {
    format: 'es',
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
  test: {
    // smoke.spec.ts is a Playwright e2e spec (preview server); keep vitest on
    // the node-side engine/matrix suites only.
    exclude: [...configDefaults.exclude, 'tests/smoke.spec.ts'],
  },
});
