/*
 * Precache-manifest diff gate (plan v0.3.0 phase 6a, red-team F3/F6).
 *
 * Compares the {url, revision} precache entries of a baseline sw.js (last
 * phase-5 generateSW build) against a candidate sw.js (injectManifest build).
 * A URL-set-only diff is NOT enough — workbox re-globbing still produces the
 * same URLs while silently losing the pinned revisions (qpdf.wasm sha256,
 * pdf.js font hashes) — so revisions are compared 1:1 too.
 *
 * Usage: node scripts/precache-diff.mjs <baseline.sw.js> <candidate.sw.js>
 * Exit 0 = manifests identical. Exit 1 = any missing/extra URL or revision
 * mismatch; both sides are printed. Exit 2 = usage/parse error.
 *
 * Manifest parsing lives in scripts/precache-manifest.mjs (shared with
 * tests/sw-precache.spec.ts).
 */
import { extractPrecacheEntries } from './precache-manifest.mjs';

const [, , basePath, candidatePath] = process.argv;
if (!basePath || !candidatePath) {
  console.error('usage: node scripts/precache-diff.mjs <baseline.sw.js> <candidate.sw.js>');
  process.exit(2);
}

const base = extractPrecacheEntries(basePath);
const cand = extractPrecacheEntries(candidatePath);

let bad = 0;
for (const [url, rev] of base) {
  if (!cand.has(url)) {
    console.error(`MISSING in candidate: ${url}`);
    bad += 1;
  } else if (cand.get(url) !== rev) {
    console.error(`REVISION CHANGED: ${url}\n  base:      ${rev}\n  candidate: ${cand.get(url)}`);
    bad += 1;
  }
}
for (const url of cand.keys()) {
  if (!base.has(url)) {
    console.error(`EXTRA in candidate: ${url}`);
    bad += 1;
  }
}
if (bad > 0) {
  console.error(`precache diff: ${bad} problem(s), base=${base.size} entries, candidate=${cand.size} entries`);
  process.exit(1);
}
console.log(`precache diff: identical (${base.size} entries, revisions pinned 1:1)`);
