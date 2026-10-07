// Phase 4a (plan v0.4.0, D8/R13): OCR runtime assets are copied from
// node_modules at build time — the repo never commits the tesseract binaries.
// Sources are the exact-pinned npm data packages (lockfile = provenance);
// the generated sha256 manifest (committed) lets CI verify the copies match.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const coreDir = `${root}node_modules/tesseract.js-core`;
const dataDir = `${root}node_modules/@tesseract.js-data`;
const publicDir = `${root}public`;
const manifestPath = `${root}scripts/tessdata-manifest.json`;

// OEM.LSTM_ONLY: only the lstm-only emscripten builds are shipped. SPIKE
// result (phase 4a, against the installed tesseract.js 7.0.0 source):
// worker-script/browser/getCore.js probes relaxedSimd FIRST, then simd, then
// plain, and always importScripts `<name>.wasm.js`. Those `.wasm.js` files are
// emscripten single-file builds (the wasm is embedded as base64 — verified:
// they contain no reference to the sibling `.wasm`), so the standalone `.wasm`
// binaries are never fetched and are NOT copied. The relaxed-simd build is
// mandatory in v7: without it every relaxedSimd-capable browser (all current
// Chrome/Firefox/Safari) would 404 on the core. The former 2-file SPIKE idea
// (simd+plain only) is dead in v7 for the same reason.
const CORE_FILES = [
  'tesseract-core-relaxedsimd-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-lstm.wasm.js',
];
const LANGS = ['eng', 'vie'];
// The data packages ship 4.0.0 (standard tesseract.js set) and
// 4.0.0_best_int; the plan picks the default (fast) set.
const TESSDATA_VARIANT = '4.0.0';

const fail = (msg) => {
  console.error(`sync-tessdata: ${msg}`);
  process.exit(1);
};

const sources = [
  ...CORE_FILES.map((f) => ({ from: `${coreDir}/${f}`, to: `tesseract-core/${f}` })),
  ...LANGS.map((l) => ({
    from: `${dataDir}/${l}/${TESSDATA_VARIANT}/${l}.traineddata.gz`,
    to: `tessdata/${l}.traineddata.gz`,
  })),
];

for (const { from } of sources) {
  if (!existsSync(from)) fail(`missing source ${from} — run npm install first`);
}

rmSync(`${publicDir}/tesseract-core`, { recursive: true, force: true });
rmSync(`${publicDir}/tessdata`, { recursive: true, force: true });

const manifest = {};
for (const { from, to } of sources) {
  mkdirSync(`${publicDir}/${to.replace(/\/[^/]+$/, '')}`, { recursive: true });
  cpSync(from, `${publicDir}/${to}`);
  manifest[to] = createHash('sha256').update(readFileSync(from)).digest('hex');
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`sync-tessdata: ${sources.length} assets synced → public/tesseract-core, public/tessdata`);
