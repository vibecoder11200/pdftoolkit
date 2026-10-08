// v0.5.0 phase 2a (red-team F1): ONNX Runtime Web wasm assets are copied
// from the pinned onnxruntime-web package into public/ort/ at build time.
// transformers.js defaults to fetching its wasm factory from the jsDelivr
// CDN (transformers.web.js wasmPathPrefix fallback) — a no-CDN invariant
// violation AND a code-execution-from-CDN risk. The worker pins
// env.backends.onnx.wasm.wasmPaths to these same-origin copies instead; the
// .wasm/.mjs extensions never match the precache `**/*.{js,css,html}` glob,
// so they stay out of the service-worker manifest by construction.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ortDist = `${root}node_modules/onnxruntime-web/dist`;
const outDir = `${root}public/ort`;
const manifestPath = `${root}scripts/ort-assets-manifest.json`;

// The jsep build is the WebGPU-capable ORT variant transformers.js loads when
// webgpu is enabled (its default picks the same family from the CDN).
const WANTED = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

mkdirSync(outDir, { recursive: true });
const manifest = {};
for (const name of WANTED) {
  const src = `${ortDist}/${name}`;
  cpSync(src, `${outDir}/${name}`);
  manifest[name] = createHash('sha256').update(readFileSync(src)).digest('hex');
}
const unused = readdirSync(ortDist).filter((f) => f.startsWith('ort-wasm-simd-threaded.jsep'));
if (unused.length < WANTED.length) {
  throw new Error(`[sync-ort-assets] onnxruntime-web dist missing expected files: found ${unused.join(', ')}`);
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[sync-ort-assets] copied ${WANTED.length} files → public/ort/`);
