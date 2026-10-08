import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPrecacheEntries } from '../scripts/precache-manifest.mjs';

/*
 * Phase 2a/2b dist guards (F1/F9) — run against the WEB build in dist/
 * (self-skip when dist/ is absent, like sw-precache.spec.ts). Enforced by
 * the stamp-out-ort-cdn-default vite plugin: it rewrites the transformers
 * jsDelivr DEFAULT into a dead sentinel, so "no CDN URL in the worker
 * chunks" became a greppable invariant instead of a library constant.
 */

const DIST = join(__dirname, '..', 'dist');

function aiWorkerChunks(): string[] {
  const dir = join(DIST, 'assets');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('ai-ocr.worker') && f.endsWith('.js'))
    .map((f) => join(dir, f));
}

function transformerChunks(): string[] {
  const dir = join(DIST, 'assets');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('transformers') && f.endsWith('.js'))
    .map((f) => join(dir, f));
}

describe.skipIf(!existsSync(join(DIST, 'sw.js')))('AI build output (dist/)', () => {
  it('AI worker chunk exists', () => {
    const chunks = aiWorkerChunks();
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      const code = readFileSync(c, 'utf8');
      // the same-origin wasmPaths pin (F1) is baked into the worker chunk
      expect(code).toContain('ort/ort-wasm-simd-threaded.asyncify.mjs');
      expect(code).toContain('pdftoolkit-ai-v1');
    }
  });

  it('NO CDN URL in any AI/transformers chunk (F1 — stamp-out makes this greppable)', () => {
    for (const c of [...aiWorkerChunks(), ...transformerChunks()]) {
      const code = readFileSync(c, 'utf8');
      expect(code, c).not.toContain('cdn.jsdelivr.net');
      expect(code, c).not.toContain('onnxruntime-web@');
    }
    // the sentinel proves the stamp plugin actually ran in this bundle
    const transformers = transformerChunks().map((c) => readFileSync(c, 'utf8')).join('');
    expect(transformers).toContain('__no_cdn_onnxruntime_web__');
  });

  it('the 26MB ORT default wasm asset is NOT emitted (dead weight — F1 pin covers it)', () => {
    const dir = join(DIST, 'assets');
    const offenders = readdirSync(dir).filter((f) => /^ort-wasm-simd-threaded\..*\.wasm$/.test(f));
    expect(offenders).toEqual([]);
  });

  it('AI worker + transformers chunks are NOT in the precache (F9 — 17MB budget)', () => {
    const entries = extractPrecacheEntries(join(DIST, 'sw.js'));
    for (const url of entries.keys()) {
      expect(url.startsWith('assets/ai-ocr.worker'), url).toBe(false);
      expect(/assets\/transformers/.test(url), url).toBe(false);
    }
  });

  it('same-origin ORT copies exist (public/ort → dist/ort)', () => {
    expect(existsSync(join(DIST, 'ort', 'ort-wasm-simd-threaded.asyncify.mjs'))).toBe(true);
    expect(existsSync(join(DIST, 'ort', 'ort-wasm-simd-threaded.asyncify.wasm'))).toBe(true);
  });
});
