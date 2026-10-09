import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
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
} from '../../src/engine/pdf-lib';
import {
  compressVectorPack,
  decryptPdf,
  encryptPdf,
  linearizePdf,
  qpdfCheck,
} from '../../src/engine/qpdf';
import { zipStore } from '../../src/lib/zip';
import { getTextOfFirstPage, pageCountOf } from './text-assert';

/*
 * Shared per-fixture tool matrix (used by the PR tier in matrix.spec.ts and
 * the nightly-only 100MB tier in matrix-100mb.spec.ts — split into separate
 * FILES on purpose: vitest's threads pool shares one process heap, and
 * stacking every tier's fixture + pdf-lib/pdf.js DOM in a single run is what
 * OOM'd the nightly matrix 4 nights in a row (2026-10-06..09).
 *
 * Memory notes for the 100MB tier: callers read the fixture lazily (see
 * matrix-100mb.spec.ts) and every heavy op here allocates its own output —
 * the zip assert compares sha256 INSTEAD of toEqual on full buffers so the
 * comparison adds zero 100MB copies.
 */

export function range1Based(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function halves(n: number): number[][] {
  const k = Math.floor(n / 2);
  return [range1Based(1, k), range1Based(k + 1, n)];
}

function reversed(n: number): number[] {
  return Array.from({ length: n }, (_, i) => n - i);
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function defineMatrix(
  label: string,
  bytes: () => Uint8Array,
  expectedPages: number,
  timeoutMs: number,
): void {
  const tag = `matrix ${label} (${expectedPages}p)`;

  it(
    `${tag}: loadPdf reports page count`,
    async () => {
      const { info } = await loadPdf(bytes());
      expect(info.numPages).toBe(expectedPages);
    },
    timeoutMs,
  );

  it(
    `${tag}: merge doubles page count`,
    async () => {
      const b = bytes();
      const out = await mergePdfs([b, b]);
      expect(out.byteLength).toBeGreaterThan(0);
      expect(await pageCountOf(out)).toBe(expectedPages * 2);
    },
    timeoutMs,
  );

  it(
    `${tag}: mergeSelected picks reopen with picked count`,
    async () => {
      const b = bytes();
      const out = await mergeSelected([b, b], [[1], [1]]);
      expect(out.byteLength).toBeGreaterThan(0);
      expect(await pageCountOf(out)).toBe(2);
    },
    timeoutMs,
  );

  it(
    `${tag}: split halves round-trip page counts`,
    async () => {
      const [first, second] = halves(expectedPages);
      const [a, b] = await splitByRanges(bytes(), [first, second]);
      expect(await pageCountOf(a)).toBe(first.length);
      expect(await pageCountOf(b)).toBe(second.length);
      expect(first.length + second.length).toBe(expectedPages);
    },
    timeoutMs,
  );

  it(
    `${tag}: extract reopens single page with selectable text`,
    async () => {
      const out = await extractPages(bytes(), [1]);
      expect(await pageCountOf(out)).toBe(1);
      expect(await getTextOfFirstPage(out)).toContain('PDFTOOLKIT FIXTURE');
    },
    timeoutMs,
  );

  it(
    `${tag}: remove drops one page`,
    async () => {
      const out = await removePages(bytes(), [expectedPages]);
      expect(await pageCountOf(out)).toBe(expectedPages - 1);
    },
    timeoutMs,
  );

  it(
    `${tag}: reorder keeps page count`,
    async () => {
      const out = await reorderPages(bytes(), reversed(expectedPages));
      expect(await pageCountOf(out)).toBe(expectedPages);
    },
    timeoutMs,
  );

  it(
    `${tag}: rotate keeps page count`,
    async () => {
      const out = await rotatePages(bytes(), [1], 90);
      expect(await pageCountOf(out)).toBe(expectedPages);
    },
    timeoutMs,
  );

  it(
    `${tag}: compressVectorPack keeps pages and selectable text`,
    async () => {
      const packed = await compressVectorPack(bytes());
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
      const out = await linearizePdf(bytes());
      expect(out.byteLength).toBeGreaterThan(0);
      expect(new TextDecoder('latin1').decode(out.slice(0, 4096))).toContain('/Linearized');
      expect(await pageCountOf(out)).toBe(expectedPages);
    },
    timeoutMs,
  );

  it(
    `${tag}: zipStore packs renamed entries under the budget`,
    async () => {
      const b = bytes();
      const zip = await zipStore([{ name: `page-${expectedPages}.png`, bytes: b }]);
      const files = unzipSync(zip);
      expect(Object.keys(files)).toEqual([`page-${expectedPages}.png`]);
      // sha256 both sides — a full-buffer toEqual would materialize two more
      // 100MB copies at exactly the wrong moment (the nightly OOM).
      expect(sha256(files[`page-${expectedPages}.png`])).toBe(sha256(b));
    },
    timeoutMs,
  );

  it(
    `${tag}: encrypt/decrypt round-trips page count`,
    async () => {
      const enc = await encryptPdf(bytes(), 'userpw', 'ownerpw', 256);
      expect(enc.byteLength).toBeGreaterThan(0);
      const dec = await decryptPdf(enc, 'userpw');
      expect(await pageCountOf(dec)).toBe(expectedPages);
    },
    timeoutMs,
  );
}
