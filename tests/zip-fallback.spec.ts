import { describe, expect, it } from 'vitest';
import { ZipSizeError, isZipSizeError } from '../src/lib/zip';

/*
 * The pdf-to-img fallback branch (over-budget ZIP → banner + per-image
 * downloads) detects ZipSizeError BY NAME, because comlink hands worker
 * throws across the boundary with the subclass prototype stripped. A future
 * refactor to `instanceof` would compile clean and break the fallback
 * silently — these tests are the guard against exactly that.
 */
describe('isZipSizeError — survives the comlink boundary', () => {
  it('matches a genuine ZipSizeError instance', () => {
    expect(isZipSizeError(new ZipSizeError(201 * 1024 * 1024))).toBe(true);
  });

  it('matches a reconstructed Error that kept only name/message (comlink rethrow)', () => {
    // Comlink rethrows worker errors preserving name/message but NOT the
    // subclass prototype (same transport contract as isEncryptedError).
    const rebuilt = new Error('zip input exceeds budget');
    rebuilt.name = 'ZipSizeError';
    expect(rebuilt instanceof ZipSizeError).toBe(false);
    expect(isZipSizeError(rebuilt)).toBe(true);
  });

  it('matches a fully serialized plain {name, message} object', () => {
    // Worst-case transport: JSON round-trip leaves no Error machinery at all.
    const plain: unknown = JSON.parse(JSON.stringify(new ZipSizeError(1)));
    expect(isZipSizeError(plain)).toBe(true);
  });

  it('rejects ordinary errors and non-errors', () => {
    expect(isZipSizeError(new Error('boom'))).toBe(false);
    const renamed = new Error('boom');
    renamed.name = 'TimeoutError';
    expect(isZipSizeError(renamed)).toBe(false);
    expect(isZipSizeError('ZipSizeError')).toBe(false);
    expect(isZipSizeError(null)).toBe(false);
    expect(isZipSizeError(undefined)).toBe(false);
  });
});
