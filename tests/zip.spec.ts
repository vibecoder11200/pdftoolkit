import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import {
  crc32,
  sanitizeEntryName,
  ZIP_MAX_TOTAL_BYTES,
  ZipSizeError,
  zipStore,
} from '../src/lib/zip';

const bytesOf = (s: string) => new TextEncoder().encode(s);

describe('crc32 (IEEE)', () => {
  it('matches the standard check vector', () => {
    expect(crc32(bytesOf('123456789'))).toBe(0xcbf43926);
  });

  it('is stable for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('zipStore round-trip', () => {
  it('fflate unzips entries byte-exact', () => {
    const a = bytesOf('hello pdftoolkit');
    const b = new Uint8Array([0, 1, 2, 255, 254, 0, 0, 7]);
    const zip = zipStore([
      { name: 'page-1.png', bytes: a },
      { name: 'page-2.png', bytes: b },
    ]);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(['page-1.png', 'page-2.png']);
    expect(Buffer.from(files['page-1.png'])).toEqual(Buffer.from(a));
    expect(Buffer.from(files['page-2.png'])).toEqual(Buffer.from(b));
  });

  it('stores method 0 (no compression) with UTF-8 flag', () => {
    const zip = zipStore([{ name: 'ảnh-1.png', bytes: bytesOf('x') }]);
    const view = new DataView(zip.buffer);
    expect(view.getUint16(8, true)).toBe(0); // method = store
    expect((view.getUint16(6, true) & 0x0800) !== 0).toBe(true); // UTF-8 flag
  });
});

describe('sanitizeEntryName', () => {
  it('strips path separators and control characters', () => {
    expect(sanitizeEntryName('../../etc/passwd')).toBe('.. .. etc passwd');
    expect(sanitizeEntryName('a\\b\\c.png')).toBe('a b c.png');
    expect(sanitizeEntryName('bad\x00\x1f\x7fname.pdf')).toBe('badname.pdf');
  });

  it('caps names at 255 UTF-8 bytes', () => {
    const long = 'ả'.repeat(300); // 3 bytes each in UTF-8
    expect(sanitizeEntryName(long).length).toBeLessThanOrEqual(85);
    expect(new TextEncoder().encode(sanitizeEntryName(long)).length).toBeLessThanOrEqual(255);
  });

  it('falls back to "file" when nothing survives', () => {
    expect(sanitizeEntryName('///')).toBe('file');
    expect(sanitizeEntryName('\x00\x1f')).toBe('file');
  });
});

describe('zipStore entry-name collisions', () => {
  it('suffixes duplicates before the extension', () => {
    const zip = zipStore([
      { name: 'stem-p1.png', bytes: bytesOf('a') },
      { name: 'stem-p1.png', bytes: bytesOf('bb') },
      { name: 'stem-p1.png', bytes: bytesOf('ccc') },
    ]);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual([
      'stem-p1-1.png',
      'stem-p1-2.png',
      'stem-p1.png',
    ]);
    expect(Buffer.from(files['stem-p1-1.png'])).toEqual(Buffer.from(bytesOf('bb')));
  });

  it('treats extension-less and sanitized names uniformly', () => {
    const zip = zipStore([
      { name: 'report', bytes: bytesOf('1') },
      { name: 'report', bytes: bytesOf('2') },
    ]);
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(['report', 'report-1']);
  });
});

describe('zipStore 200MB budget', () => {
  it('rejects payloads above the cap with ZipSizeError', () => {
    const big = new Uint8Array(ZIP_MAX_TOTAL_BYTES + 1);
    expect(() => zipStore([{ name: 'big.bin', bytes: big }])).toThrow(ZipSizeError);
  });

  it('accepts payloads at the cap boundary minus one entry', () => {
    // One byte under the cap must NOT throw (allocation happens after the check).
    const big = new Uint8Array(ZIP_MAX_TOTAL_BYTES - 1);
    const zip = zipStore([{ name: 'big.bin', bytes: big }]);
    expect(zip.byteLength).toBeGreaterThan(ZIP_MAX_TOTAL_BYTES - 1);
  });
});
