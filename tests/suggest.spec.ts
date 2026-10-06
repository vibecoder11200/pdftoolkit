import { describe, expect, it } from 'vitest';
import { buildSuggestions } from '../src/lib/suggest';
import type { PdfInfo } from '../src/engine/pdf-lib';

// buildSuggestions takes an injectable loadPdfInfo so these tests never touch
// the Worker. Node's File (undici) supports slice()/arrayBuffer(), which is
// all the tier-1 magic sniff needs.
function pdfFile(name = 'doc.pdf', size = 1024): File {
  const bytes = new Uint8Array(Math.max(size, 8));
  bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
  return new File([bytes], name, { type: 'application/pdf' });
}

function bytesFile(name: string, content: string, type: string): File {
  return new File([new TextEncoder().encode(content)], name, { type });
}

const okLoader = async (bytes: Uint8Array): Promise<PdfInfo> =>
  ({
    numPages: 2,
    pageInfos: [],
    fingerprint: 'f',
    fileSizeBytes: bytes.byteLength,
  }) as PdfInfo;

const lockedLoader = async (): Promise<PdfInfo> => {
  const err = new Error(
    'Input document to `PDFDocument.load` is encrypted. You can use `PDFDocument.load(bytes, { ignoreEncryption: true })`.',
  );
  err.name = 'EncryptedPDFError';
  throw err;
};

const corruptLoader = async (bytes: Uint8Array): Promise<PdfInfo> => {
  // Corrupt exactly one file in mixed batches: the small one.
  if (bytes.byteLength <= 1024) throw new Error('Cannot parse broken document');
  return okLoader(bytes);
};

const neverLoader = (): Promise<PdfInfo> => new Promise(() => undefined);

describe('buildSuggestions — tier 1', () => {
  it('single PDF → compress first, plus the all-tools grid', async () => {
    const r = await buildSuggestions([pdfFile()], { loadPdfInfo: okLoader });
    expect(r.suggestions.map((s) => s.slug)).toEqual(['compress']);
    expect(r.showAllTools).toBe(true);
    expect(r.rejected).toEqual([]);
  });

  it('two PDFs → merge first, then compress; no all-tools grid', async () => {
    const r = await buildSuggestions([pdfFile('a.pdf'), pdfFile('b.pdf')], { loadPdfInfo: okLoader });
    expect(r.suggestions.map((s) => s.slug)).toEqual(['merge', 'compress']);
    expect(r.showAllTools).toBe(false);
  });

  it('PDF + image mix → compress for the PDF, img-to-pdf for the images', async () => {
    const r = await buildSuggestions([pdfFile('a.pdf'), bytesFile('photo.jpg', 'x', 'image/jpeg')], {
      loadPdfInfo: okLoader,
    });
    expect(r.suggestions.map((s) => s.slug)).toEqual(['compress', 'img-to-pdf']);
  });

  it('images only → img-to-pdf top, no PDF suggestions', async () => {
    const r = await buildSuggestions(
      [bytesFile('a.png', 'x', 'image/png'), bytesFile('b.jpeg', 'x', 'image/jpeg')],
      { loadPdfInfo: okLoader },
    );
    expect(r.suggestions.map((s) => s.slug)).toEqual(['img-to-pdf']);
    expect(r.showAllTools).toBe(false);
  });

  it('webp is NOT suggested img-to-pdf — it lands in rejected', async () => {
    const r = await buildSuggestions([bytesFile('pic.webp', 'x', 'image/webp')], { loadPdfInfo: okLoader });
    expect(r.suggestions).toEqual([]);
    expect(r.rejected).toEqual([{ name: 'pic.webp', reason: 'unsupported' }]);
  });

  it('a .pdf-named file without PDF magic is rejected as not-pdf', async () => {
    const r = await buildSuggestions([bytesFile('fake.pdf', 'hello world', 'application/pdf')], {
      loadPdfInfo: okLoader,
    });
    expect(r.suggestions).toEqual([]);
    expect(r.rejected).toEqual([{ name: 'fake.pdf', reason: 'not-pdf' }]);
  });

  it('heic is refused regardless of extension casing', async () => {
    const r = await buildSuggestions([bytesFile('IMG_0001.HEIC', 'x', 'image/heic')], {
      loadPdfInfo: okLoader,
    });
    expect(r.rejected).toEqual([{ name: 'IMG_0001.HEIC', reason: 'heic-refused' }]);
  });

  it('over 200MB is rejected as too-large', async () => {
    const big = pdfFile('huge.pdf', 201 * 1024 * 1024);
    const r = await buildSuggestions([big], { loadPdfInfo: okLoader });
    expect(r.rejected).toEqual([{ name: 'huge.pdf', reason: 'too-large' }]);
  });
});

describe('buildSuggestions — tier 2 (worker parse, injectable)', () => {
  it('locked PDF → encrypt with decrypt mode first', async () => {
    const r = await buildSuggestions([pdfFile('locked.pdf')], { loadPdfInfo: lockedLoader });
    expect(r.suggestions[0]).toEqual({
      slug: 'encrypt',
      mode: 'decrypt',
      reasonKey: 'home.reason_decrypt',
    });
    expect(r.showAllTools).toBe(false);
  });

  it('corrupt PDF → unsupported row, remaining PDFs still suggest', async () => {
    const r = await buildSuggestions([pdfFile('broken.pdf'), pdfFile('good.pdf', 2048)], {
      loadPdfInfo: corruptLoader,
    });
    expect(r.rejected).toEqual([{ name: 'broken.pdf', reason: 'corrupt' }]);
    expect(r.suggestions.map((s) => s.slug)).toEqual(['compress']);
  });

  it('tier-2 is skipped past the file cap — no locked detection', async () => {
    const four = [pdfFile('1.pdf'), pdfFile('2.pdf'), pdfFile('3.pdf'), pdfFile('4.pdf')];
    const r = await buildSuggestions(four, { loadPdfInfo: lockedLoader });
    expect(r.suggestions.map((s) => s.slug)).toEqual(['merge', 'compress']);
    expect(r.suggestions[0].mode).toBeUndefined();
  });

  it('tier-2 is skipped past the size cap (>10MB per file)', async () => {
    const r = await buildSuggestions([pdfFile('big.pdf', 11 * 1024 * 1024)], {
      loadPdfInfo: lockedLoader,
    });
    expect(r.suggestions.map((s) => s.slug)).toEqual(['compress']);
    expect(r.suggestions[0].mode).toBeUndefined();
  });

  it('timeout downgrades to tier-1 instead of guessing', async () => {
    const r = await buildSuggestions([pdfFile('slow.pdf')], { loadPdfInfo: neverLoader });
    expect(r.suggestions.map((s) => s.slug)).toEqual(['compress']);
    expect(r.rejected).toEqual([]);
  }, 10_000);
});
