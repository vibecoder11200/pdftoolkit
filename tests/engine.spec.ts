import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  extractPages,
  mergePdfs,
  removePages,
  reorderPages,
  rotatePages,
  splitByRanges,
} from '../src/engine/pdf-lib';
import { compressVectorPack, decryptPdf, encryptPdf, qpdfCheck } from '../src/engine/qpdf';
import { getTextOfFirstPage, pageCountOf } from './helpers/text-assert';

const fixture = new Uint8Array(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fixture-1mb.pdf')),
);

describe('engine core (phase 2)', () => {
  it('removePages drops pages and keeps text selectable', async () => {
    const out = await removePages(fixture, [2]);
    expect(await pageCountOf(out)).toBe(1);
    expect(await getTextOfFirstPage(out)).toContain('PDFTOOLKIT FIXTURE');
  });

  it('reorderPages reverses order', async () => {
    const out = await reorderPages(fixture, [2, 1]);
    expect(await pageCountOf(out)).toBe(2);
    expect(await getTextOfFirstPage(out)).toContain('page 2/2');
  });

  it('rotatePages keeps page count', async () => {
    const out = await rotatePages(fixture, [1], 90);
    expect(await pageCountOf(out)).toBe(2);
  });

  it('merge/split/extract round-trip page counts', async () => {
    const merged = await mergePdfs([fixture, fixture]);
    expect(await pageCountOf(merged)).toBe(4);
    const [a, b] = await splitByRanges(merged, [[1, 2], [3, 4]]);
    expect(await pageCountOf(a)).toBe(2);
    expect(await pageCountOf(b)).toBe(2);
    const one = await extractPages(merged, [3]);
    expect(await pageCountOf(one)).toBe(1);
  });

  it('qpdf vector-pack keeps text; encrypt/decrypt round-trips', async () => {
    const packed = await compressVectorPack(fixture);
    await qpdfCheck(packed);
    expect(await getTextOfFirstPage(packed)).toContain('PDFTOOLKIT FIXTURE');
    const enc = await encryptPdf(fixture, 'userpw', 'ownerpw', 256);
    const dec = await decryptPdf(enc, 'userpw');
    expect(await pageCountOf(dec)).toBe(2);
  });
});

describe('self-sign PKCS#7 (phase 5, spike S3)', () => {
  it('addSelfSignature produces a verifiable detached signature', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const { addSelfSignature } = await import('../src/lib/sign');
    const doc = await PDFDocument.load(fixture.slice());
    const signed = await addSelfSignature(doc);

    // Real /Contents, ByteRange coverage adds up (spike S3 invariants).
    const latin = Buffer.from(signed).toString('latin1');
    const br = latin.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
    expect(br).not.toBeNull();
    const [b0, b1, b2, b3] = br!.slice(1).map(Number);
    expect(b0).toBe(0);
    expect(latin[b0 + b1]).toBe('<');
    expect(latin[b2 - 1]).toBe('>');
    expect(b2 + b3).toBe(signed.length);
    const contentsHex = latin.slice(b0 + b1 + 1, b2 - 1);
    expect(/[^0]/.test(contentsHex)).toBe(true); // real DER, not the 8192-zero placeholder

    // Independent reopen + structural check.
    expect(await pageCountOf(signed)).toBe(2);
    await qpdfCheck(signed);
  });

  it('rejects signing an already-signed file (single signature)', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const { addSelfSignature } = await import('../src/lib/sign');
    const doc = await PDFDocument.load(fixture.slice());
    const signed = await addSelfSignature(doc);
    const again = await PDFDocument.load(signed);
    await expect(addSelfSignature(again)).rejects.toThrow('already-signed');
  });
});
