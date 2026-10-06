import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractPrecacheEntries } from '../scripts/precache-manifest.mjs';

/*
 * CI-enforced precache revision pins (plan v0.3.0 phase 6a, red-team F3/F6).
 *
 * The SW manifest must pin the content hash of stable-filename assets so a
 * swapped binary can never silently serve from an old precache entry
 * (vite.config.ts manifestTransforms writes the pins; this test reads the BUILT
 * dist/sw.js and proves they survived the build). Needs `npm run build` first;
 * skipped on a fresh clone without dist/.
 *
 * The companion gate comparing the whole {url, revision} manifest against the
 * phase-5 baseline lives in scripts/precache-diff.mjs (run after builds).
 */

const swPath = 'dist/sw.js';
const hasBuild = existsSync(swPath);

describe.skipIf(!hasBuild)('dist/sw.js precache pins', () => {
  const manifest = extractPrecacheEntries(swPath);

  it('parses a non-empty precache manifest containing the app shell', () => {
    expect(manifest.size).toBeGreaterThan(20);
    expect(manifest.has('index.html')).toBe(true);
  });

  it('pins assets/qpdf.wasm to the sha256 of the installed wasm package', () => {
    const wasm = readFileSync('node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm');
    const expected = createHash('sha256').update(wasm).digest('hex');
    expect(manifest.get('assets/qpdf.wasm'), 'qpdf.wasm must be revision-pinned').toBe(expected);
  });

  it('pins the pdf.js standard fonts to their content hashes', () => {
    const fonts = readdirSync('node_modules/pdfjs-dist/standard_fonts').filter((f) =>
      /\.(pfb|ttf)$/.test(f),
    );
    expect(fonts.length).toBeGreaterThan(0);
    const unpinned: string[] = [];
    const wrong: string[] = [];
    for (const f of fonts) {
      const url = `assets/standard_fonts/${f}`;
      const expected = createHash('sha256')
        .update(readFileSync(`node_modules/pdfjs-dist/standard_fonts/${f}`))
        .digest('hex');
      const actual = manifest.get(url);
      if (actual === null || actual === undefined) unpinned.push(url);
      else if (actual !== expected) wrong.push(`${url}: ${actual} != ${expected}`);
    }
    expect(unpinned, 'fonts must be revision-pinned').toEqual([]);
    expect(wrong, 'font revisions must match content').toEqual([]);
  });
});
