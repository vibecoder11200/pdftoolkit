import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

async function makePdf(pages, label, seedLines) {
  const doc = await PDFDocument.create();
  doc.setTitle(`pdftoolkit-fixture-${label}`);
  doc.setCreator('pdftoolkit-gen');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= pages; p += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(`PDFTOOLKIT FIXTURE ${label} — page ${p}/${pages}`, {
      x: 48,
      y: 800,
      size: 13,
      font,
    });
    for (let i = 0; i < seedLines; i += 1) {
      page.drawText(
        `Line ${i + 1}: The quick brown fox jumps over the lazy dog. 0123456789. `.repeat(4),
        { x: 48, y: Math.max(40, 770 - i * 11), size: 8, font },
      );
    }
  }
  return doc.save({ useObjectStreams: false });
}

const small = await makePdf(2, '1mb', 40);
const medium = await makePdf(40, '10mb', 60);

mkdirSync(here, { recursive: true });
writeFileSync(join(here, 'fixture-1mb.pdf'), small);
writeFileSync(join(here, 'fixture-10mb.pdf'), medium);
console.log(JSON.stringify({ 'fixture-1mb.pdf': small.length, 'fixture-10mb.pdf': medium.length }));

// Nightly-only 100MB branch. PR never runs this: default
// `node tests/fixtures/gen.mjs` stops above. CI nightly opts in via
// `node tests/fixtures/gen.mjs --large` (or MATRIX_100MB=1) and then runs
// the 100MB matrix tier. ~4500 pages x 500 seed lines ≈ 100MB given the
// measured ~23KB/page at 10p x 500l. The matrix spec expects NIGHTLY_PAGES
// below to equal LARGE_PAGES here — keep them in sync.
const LARGE_PAGES = 4500;
const LARGE_LINES = 500;
const wantLarge =
  process.argv.includes('--large') || process.env.MATRIX_100MB === '1';
if (wantLarge) {
  const large = await makePdf(LARGE_PAGES, '100mb', LARGE_LINES);
  writeFileSync(join(here, 'fixture-100mb.pdf'), large);
  console.log(JSON.stringify({ 'fixture-100mb.pdf': large.length }));
}
