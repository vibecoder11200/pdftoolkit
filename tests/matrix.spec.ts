import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import {
  extractPages,
  loadPdf,
  mergePdfs,
  mergeSelected,
  removePages,
  reorderPages,
  rotatePages,
  splitByRanges,
} from '../src/engine/pdf-lib';
import {
  compressVectorPack,
  decryptPdf,
  encryptPdf,
  linearizePdf,
  qpdfCheck,
} from '../src/engine/qpdf';
import { zipStore } from '../src/lib/zip';
import { getTextOfFirstPage, pageCountOf } from './helpers/text-assert';

// Phase 6 test matrix (PR tier): fixtures 1MB + 10MB x every P0 tool path
// reachable from src/engine/client.ts.
// The client itself is a thin Worker proxy (Client.ts re-exports WorkerApi),
// and WorkerApi delegates 1:1 to these same pdf-lib/qpdf functions, so the
// matrix imports them directly exactly like tests/engine.spec.ts does —
// Node/vitest has no Web Worker, and this keeps the engine-suite pattern.
// NOTE (reachability): `metadata` (src/components/workspace/metadata-tool.tsx
// drives pdf-lib setTitle/setAuthor/... directly, no engine import) and the
// image-sign embed (src/components/workspace/sign-tool.tsx embedPng/drawImage
// via pdf-lib; its only engine call is loadPdf) expose NO method on
// src/engine/client.ts, so they have no matrix row here. Covered below is
// everything the client exposes: loadPdf, merge(Pdfs/Selected), splitRanges,
// extract, remove, reorder, rotate, compressVectorPack, encrypt+decrypt,
// qpdfCheck. The 100MB tier is nightly-only (see bottom of file + gen.mjs).

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface FixtureCase {
  label: string;
  file: string;
  pages: number;
}

// Page counts mirror tests/fixtures/gen.mjs: makePdf(2, '1mb', 40) and
// makePdf(40, '10mb', 60).
const PR_CASES: FixtureCase[] = [
  { label: '1MB', file: 'fixture-1mb.pdf', pages: 2 },
  { label: '10MB', file: 'fixture-10mb.pdf', pages: 40 },
];

function range1Based(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function halves(n: number): number[][] {
  const k = Math.floor(n / 2);
  return [range1Based(1, k), range1Based(k + 1, n)];
}

function reversed(n: number): number[] {
  return Array.from({ length: n }, (_, i) => n - i);
}

function defineMatrix(label: string, bytes: Uint8Array, expectedPages: number, timeoutMs: number): void {
  const tag = `matrix ${label} (${expectedPages}p)`;

  it(
    `${tag}: loadPdf reports page count`,
    async () => {
      const { info } = await loadPdf(bytes);
      expect(info.numPages).toBe(expectedPages);
    },
    timeoutMs,
  );

  it(
    `${tag}: merge doubles page count`,
    async () => {
      const out = await mergePdfs([bytes, bytes]);
      expect(out.byteLength).toBeGreaterThan(0);
      expect(await pageCountOf(out)).toBe(expectedPages * 2);
    },
    timeoutMs,
  );

  it(
    `${tag}: mergeSelected picks reopen with picked count`,
    async () => {
      const out = await mergeSelected([bytes, bytes], [[1], [1]]);
      expect(out.byteLength).toBeGreaterThan(0);
      expect(await pageCountOf(out)).toBe(2);
    },
    timeoutMs,
  );

  it(
    `${tag}: split halves round-trip page counts`,
    async () => {
      const [first, second] = halves(expectedPages);
      const [a, b] = await splitByRanges(bytes, [first, second]);
      expect(await pageCountOf(a)).toBe(first.length);
      expect(await pageCountOf(b)).toBe(second.length);
      expect(first.length + second.length).toBe(expectedPages);
    },
    timeoutMs,
  );

  it(
    `${tag}: extract reopens single page with selectable text`,
    async () => {
      const out = await extractPages(bytes, [1]);
      expect(await pageCountOf(out)).toBe(1);
      expect(await getTextOfFirstPage(out)).toContain('PDFTOOLKIT FIXTURE');
    },
    timeoutMs,
  );

  it(
    `${tag}: remove drops one page`,
    async () => {
      const out = await removePages(bytes, [expectedPages]);
      expect(await pageCountOf(out)).toBe(expectedPages - 1);
    },
    timeoutMs,
  );

  it(
    `${tag}: reorder keeps page count`,
    async () => {
      const out = await reorderPages(bytes, reversed(expectedPages));
      expect(await pageCountOf(out)).toBe(expectedPages);
    },
    timeoutMs,
  );

  it(
    `${tag}: rotate keeps page count`,
    async () => {
      const out = await rotatePages(bytes, [1], 90);
      expect(await pageCountOf(out)).toBe(expectedPages);
    },
    timeoutMs,
  );

  it(
    `${tag}: compressVectorPack keeps pages and selectable text`,
    async () => {
      const packed = await compressVectorPack(bytes);
      expect(packed.byteLength).toBeGreaterThan(0);
      await qpdfCheck(packed);
      expect(await pageCountOf(packed)).toBe(expectedPages);
      expect(await getTextOfFirstPage(packed)).toContain('PDFTOOLKIT FIXTURE');
    },
    timeoutMs,
  );

  it(
    `${tag}: linearizePdf marks fast-web-view and keeps pages`,
    async () => {
      const out = await linearizePdf(bytes);
      expect(out.byteLength).toBeGreaterThan(0);
      expect(new TextDecoder('latin1').decode(out.slice(0, 4096))).toContain('/Linearized');
      expect(await pageCountOf(out)).toBe(expectedPages);
    },
    timeoutMs,
  );

  it(
    `${tag}: zipStore packs renamed entries under the budget`,
    async () => {
      const zip = await zipStore([{ name: `page-${expectedPages}.png`, bytes }]);
      const files = unzipSync(zip);
      expect(Object.keys(files)).toEqual([`page-${expectedPages}.png`]);
      expect(Buffer.from(files[`page-${expectedPages}.png`])).toEqual(Buffer.from(bytes));
    },
    timeoutMs,
  );

  it(
    `${tag}: encrypt/decrypt round-trips page count`,
    async () => {
      const enc = await encryptPdf(bytes, 'userpw', 'ownerpw', 256);
      expect(enc.byteLength).toBeGreaterThan(0);
      const dec = await decryptPdf(enc, 'userpw');
      expect(await pageCountOf(dec)).toBe(expectedPages);
    },
    timeoutMs,
  );
}

for (const c of PR_CASES) {
  describe(`matrix ${c.label}`, () => {
    const bytes = new Uint8Array(readFileSync(join(fixturesDir, c.file)));
    defineMatrix(c.label, bytes, c.pages, 120_000);
  });
}

// Nightly-only 100MB tier. tests/fixtures/gen.mjs writes fixture-100mb.pdf
// ONLY when invoked with --large / MATRIX_100MB=1 / schedule event; the
// default `node tests/fixtures/gen.mjs` (PR) never creates it, so PR runs
// cannot pick it up here either: both the env arm AND the file must exist.
const NIGHTLY_FILE = 'fixture-100mb.pdf';
// Expected pages must match the --large branch of tests/fixtures/gen.mjs.
const NIGHTLY_PAGES = 4500;
const nightlyArmed = env.MATRIX_100MB === '1' || env.GITHUB_EVENT_NAME === 'schedule';
if (nightlyArmed && existsSync(join(fixturesDir, NIGHTLY_FILE))) {
  describe('matrix 100MB [nightly-only]', () => {
    const bytes = new Uint8Array(readFileSync(join(fixturesDir, NIGHTLY_FILE)));
    defineMatrix('100MB [nightly-only]', bytes, NIGHTLY_PAGES, 600_000);
  });
}
