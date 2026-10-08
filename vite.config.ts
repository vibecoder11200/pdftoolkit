import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Build identity for the footer chip (plan v0.3.0 phase 2, D8): single source
// of truth at build time — a forgotten package.json bump still shows the real
// commit. try/catch because tarball checkouts have no .git.
const appVersion = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')).version;
const commitHash = (() => {
  try {
    return execSync('git rev-parse --short=7 HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
})();

// Emit qpdf.wasm next to the worker chunk: the emscripten glue resolves it
// relative to the worker script dir (/assets/), and the lazy dynamic import
// keeps it out of the initial bundle. Node (vitest) reads it from node_modules.
const qpdfWasm = readFileSync(
  fileURLToPath(new URL('./node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm', import.meta.url)),
);

// Phase 7 (D9 GO, 25.1% avg size reduction measured in scripts/ab-mozjpeg.mjs):
// the jsquash mozjpeg encoder wasm gets the same treatment as qpdf.wasm —
// stable filename under assets/ + an explicit sha256 precache pin.
const mozjpegWasm = readFileSync(
  fileURLToPath(new URL('./node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm', import.meta.url)),
);

// sha256 of node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm, refreshed
// here whenever the pinned package version in package.json changes. The
// precache entry for assets/qpdf.wasm gets content-hash URLs for JS (revision
// null = hash-in-filename) but the wasm keeps a stable filename, so pin its
// revision explicitly: a corrupt or swapped wasm can never silently serve
// from an old precache entry.
const qpdfWasmRevision = createHash('sha256').update(qpdfWasm).digest('hex');

const mozjpegWasmRevision = createHash('sha256').update(mozjpegWasm).digest('hex');

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

// D11 (red-team R2): CSP is per-target. Web keeps the authored meta CSP;
// the desktop build swaps the meta for the desktop CSP (ipc:/asset: connect
// allowances — Tauri patches nonces into BOTH this meta and security.csp at
// serve time, so the IPC init scripts stay allowed). tauri.conf.json carries
// the identical string via security.csp — keep the two in sync.
const DESKTOP_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' ipc: http://ipc.localhost asset: http://asset.localhost https://asset.localhost; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'";

// v0.5.0 phase 2a (red-team F1): transformers.js carries a jsDelivr
// wasmPaths DEFAULT (its wasm factory fallback). The worker pins same-origin
// paths before any session, so the default must never fire — stamp the URL
// out of every chunk so a regression becomes a loud same-origin 404 instead
// of a silent CDN fetch. This also makes the dist grep test
// (tests/ai-build.spec.ts) enforceable: the bundled library constant would
// otherwise defeat any negative grep. Registered in BOTH bands (client
// plugins[] and worker.plugins) — vite builds workers in a separate band.
const stampOutOrtCdn = {
  name: 'stamp-out-ort-cdn-default',
  apply: 'build' as const,
  generateBundle(_options: unknown, bundle: Record<string, { type: string; code?: string }>) {
    const CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@';
    for (const file of Object.values(bundle)) {
      if (file.type === 'chunk' && file.code && file.code.includes(CDN)) {
        file.code = file.code.replaceAll(CDN, '__no_cdn_onnxruntime_web__');
      }
    }
    // The ORT glue bundled inside the transformers chunk resolves its DEFAULT
    // wasm by URL — which made vite emit a 26MB asyncify wasm asset. The
    // worker ALWAYS pins wasmPaths to the same-origin jsep copies (F1) before
    // any session, so the asset is unreachable dead weight (+26MB bundle) —
    // drop it.
    for (const name of Object.keys(bundle)) {
      if (/ort-wasm-simd-threaded\..*\.wasm$/.test(name)) delete bundle[name];
    }
  },
};

export default defineConfig({
  // Phase 7: the dep prebundle breaks the emscripten glue's import.meta.url
  // → wasm 404 in dev. Build output is unaffected.
  optimizeDeps: {
    exclude: ['@jsquash/jpeg'],
  },
  // D10 (red-team R1, tauri#12332): desktop base is '/' — NOT './'. With
  // './' a reload at /tools/* resolves assets against the route and Tauri's
  // no-redirect fallback serves index.html as JS (blank window). Web keeps
  // the GitHub Pages base. TAURI_ENV_PLATFORM is set by the tauri CLI for
  // both `tauri dev` and `tauri build`; plain `npm run dev/build` never sees
  // it, so web output is byte-stable.
  base: process.env.TAURI_ENV_PLATFORM ? '/' : '/pdftoolkit/',
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
    {
      // index.html references boot/favicons as %BASE_URL%… for the BUILD (the
      // SW navigateFallback serves index.html on offline deep links, so the
      // URL must be base-absolute, not relative — see public/theme-boot.js).
      // In dev, vite's env hook resolves %BASE_URL% first and the dev HTML
      // rebasing then prepends base AGAIN (…/pdftoolkit/pdftoolkit/…  → SPA
      // fallback 404). Stripping the placeholder pre-transform lets dev's own
      // rebasing resolve the now-relative URLs against publicDir exactly once.
      name: 'strip-base-url-in-dev',
      apply: 'serve',
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          return html.replaceAll('%BASE_URL%', '');
        },
      },
    },
    tailwindcss(),
    {
      // D11 (red-team R2): swap the meta CSP to the desktop variant for
      // `tauri build`/`tauri dev` only — web output is untouched (byte-stable
      // vs the authored index.html). security.csp in tauri.conf.json carries
      // the same string; keep the two in sync.
      name: 'desktop-csp',
      apply: 'build',
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          if (!process.env.TAURI_ENV_PLATFORM) return html;
          return html.replace(
            /(<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content=")[^"]*(")/,
            `$1${DESKTOP_CSP}$2`,
          );
        },
      },
    },
    {
      name: 'emit-qpdf-wasm',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'assets/qpdf.wasm', source: qpdfWasm });
        this.emitFile({
          type: 'asset',
          fileName: 'assets/mozjpeg_enc.wasm',
          source: mozjpegWasm,
        });
        for (const f of standardFonts) {
          this.emitFile({
            type: 'asset',
            fileName: `assets/standard_fonts/${f}`,
            source: readFileSync(standardFontsDir + f),
          });
        }
      },
    },

    stampOutOrtCdn,
    VitePWA({
      registerType: 'prompt', // deploy B of the phase-2 two-step bridge: the banner cohort is now on app-new
      // Phase 6a: custom SW (src/sw.ts) so the share-target fetch handler can
      // live in the same worker (phase 6b). The runtime routes in sw.ts mirror
      // what generateSW emitted before — scripts/precache-diff.mjs gates the
      // {url, revision} manifest against the phase-5 baseline on every build.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        // Fonts are build-emitted (not in public/), so they must be globbed
        // here — includeAssets only sees publicDir. Favicon set, PWA icons
        // and the webmanifest are precached too: an offline cold start (SW
        // navigateFallback) still needs theme-boot.js (**/*.js covers it),
        // the tab icon and the install manifest (red-team #16).
        globPatterns: [
          '**/*.{js,css,html}',
          'assets/qpdf.wasm',
          'assets/mozjpeg_enc.wasm',
          'assets/standard_fonts/*',
          // Phase 4a (D8): tesseract core+tessdata are copied into public/ by
          // scripts/sync-tessdata.mjs but deliberately NOT precached — the
          // measured set is ~17MB (3 single-file .wasm.js core builds + 2
          // traineddata.gz) vs the hard 17MB precache budget, so ocr.ts
          // fetches them same-origin on first use and pins them in a Cache
          // API store (offline after the first OCR run; desktop serves them
          // straight from the on-disk bundle). The tesseract worker chunk
          // (?url → assets/worker.min-<hash>.js, ~100KB) stays precached.
          'favicon.svg',
          'favicon-32.png',
          'apple-touch-icon-180.png',
          'icons/*.png',
          'manifest.webmanifest',
        ],
        // Phase 4a: the **/*.js glob would otherwise sweep the tesseract
        // single-file core builds (~11.7MB) into the precache — excluded here
        // because ocr.ts lazy-caches them on first use instead (see above).
        // v0.5.0 phase 2b (F9): same for the AI worker chunk (~1.7MB of
        // transformers.js — loaded on first AI OCR use, fetched same-origin;
        // the public/ort wasm pair never matches the glob anyway, but the
        // ignore is belt-and-braces against future glob changes).
        globIgnores: [
          'tesseract-core/**',
          'tessdata/**',
          'assets/ai-ocr.worker-*.js',
          'assets/transformers*.js',
          'ort/**',
        ],
        maximumFileSizeToCacheInBytes: 30 * 1024 ** 2,
        // Pin the content hash of stable-filename assets (qpdf.wasm, fonts)
        // so a swapped binary can never silently serve from an old precache
        // entry (see qpdfWasmRevision / fontRevisions).
        manifestTransforms: [
          (entries) => ({
            manifest: entries.map((entry) => {
              if (entry.url === 'assets/qpdf.wasm') {
                return { ...entry, revision: qpdfWasmRevision };
              }
              if (entry.url === 'assets/mozjpeg_enc.wasm') {
                return { ...entry, revision: mozjpegWasmRevision };
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
        theme_color: '#0078c6',
        // OS "open with" PDFs → this app. focus-existing keeps an in-progress
        // session alive; the launch-queue consumer routes files from there.
        file_handlers: [{ action: './', accept: { 'application/pdf': ['.pdf'] } }],
        launch_handler: { client_mode: 'focus-existing' },
        // Android share sheet → SW intercepts the POST to ./share-target
        // (src/sw.ts) and 303s home with the files in tow (phase 6b).
        share_target: {
          action: './share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: { files: [{ name: 'files', accept: ['application/pdf', '.pdf'] }] },
        },
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
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __COMMIT_HASH__: JSON.stringify(commitHash),
  },
  worker: {
    format: 'es',
    // the worker band needs the same F1 stamp — see stampOutOrtCdn above
    plugins: () => [stampOutOrtCdn],
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
  test: {
    // *.e2e.spec.ts are Playwright specs (preview server); keep vitest on
    // the node-side engine/matrix suites only.
    exclude: [...configDefaults.exclude, 'tests/*.e2e.spec.ts'],
  },
});
