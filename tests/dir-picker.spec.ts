import { describe, expect, it } from 'vitest';
import {
  DIR_PICK_MAX_TOTAL_BYTES,
  filterDirEntries,
  toDirPickOutcome,
} from '../src/lib/dir-picker';

const mkFile = (name: string, size: number): File =>
  new File([new Uint8Array(size)], name, { type: 'application/octet-stream' });

describe('filterDirEntries', () => {
  it('keeps only matching extensions (case-insensitive), no webp for images', () => {
    const files = [
      mkFile('a.PDF', 10),
      mkFile('b.pdf', 10),
      mkFile('c.txt', 10),
      mkFile('d.jpg', 10),
      mkFile('e.JPEG', 10),
      mkFile('f.png', 10),
      mkFile('g.webp', 10),
    ];
    const pdfs = filterDirEntries(files, ['.pdf']);
    expect(pdfs.files.map((f) => f.name)).toEqual(['a.PDF', 'b.pdf']);
    expect(pdfs.skippedEmpty).toBe(0);
    const imgs = filterDirEntries(files, ['.jpg', '.jpeg', '.png']);
    expect(imgs.files.map((f) => f.name).sort()).toEqual(['d.jpg', 'e.JPEG', 'f.png']);
  });

  it('sorts by name with numeric awareness and counts 0-byte skips', () => {
    const files = [
      mkFile('scan-10.pdf', 5),
      mkFile('scan-2.pdf', 0),
      mkFile('scan-1.pdf', 5),
      mkFile('scan-9.pdf', 5),
    ];
    const out = filterDirEntries(files, ['.pdf']);
    expect(out.files.map((f) => f.name)).toEqual(['scan-1.pdf', 'scan-9.pdf', 'scan-10.pdf']);
    expect(out.skippedEmpty).toBe(1);
  });
});

describe('toDirPickOutcome budget (500MB total bytes)', () => {
  it('passes under the cap and reports skipped count', () => {
    const out = toDirPickOutcome({ files: [mkFile('a.pdf', 1024), mkFile('b.pdf', 2048)], skippedEmpty: 2 });
    expect(out).toEqual({ ok: true, files: expect.any(Array), skippedEmpty: 2 });
  });

  it('rejects over the cap with the offending total', () => {
    const files = [mkFile('a.pdf', DIR_PICK_MAX_TOTAL_BYTES), mkFile('b.pdf', 1)];
    const out = toDirPickOutcome({ files, skippedEmpty: 0 });
    expect(out).toEqual({ ok: false, reason: 'budget', totalBytes: DIR_PICK_MAX_TOTAL_BYTES + 1 });
  });

  it('accepts exactly at the cap', () => {
    const out = toDirPickOutcome({ files: [mkFile('a.pdf', DIR_PICK_MAX_TOTAL_BYTES)], skippedEmpty: 0 });
    expect(out.ok).toBe(true);
  });
});
